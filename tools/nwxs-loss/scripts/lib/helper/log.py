# coding=utf8
"""统一日志配置模块。

使用 loguru 替代标准 logging，支持终端+文件双输出。

用法：
    from helper.log import logger
    logger.info('消息')
    logger.bind(step='CALC').info('带二级标签')

    # 配置文件输出
    from helper.log import setup_logger
    setup_logger(log_dir='path/to/log', name='app')
"""

import os
import sys
import threading
import time
import warnings
from datetime import datetime
from functools import wraps

from loguru import logger
from rich.console import Console
from rich.pretty import pretty_repr
from rich.traceback import install

warnings.filterwarnings('ignore', message='Field name "schema"')

install(
    console=Console(width=200),
    show_locals=False,
    word_wrap=True,
    width=200,
    code_width=180,
    locals_max_string=120,
    locals_max_length=200,
)


def _is_df(obj):
    """延迟识别 pandas DataFrame，避免在 log.py 顶层 import pandas。"""
    return type(obj).__name__ == 'DataFrame' and 'pandas' in (type(obj).__module__ or '')


def _patch(record):
    """patcher: 将 bind(step=...) 拼入 message，空则不占位。"""
    step = record['extra'].get('step', '')
    if step:
        record['message'] = f'{step} | {record["message"]}'


# 全局自动识别：loguru 在 patcher 阶段已将 message 调 str() 转为字符串，
# 拿不到原始 dict/list/DataFrame，故须在 _log 入口（str 化之前）拦截。
# 仅对无格式化参数（args/kwargs 均空）的调用生效，不影响 logger.info("fmt {}", val) 这类调用。
_orig_log = type(logger)._log


def _format_for_display(data):
    """dict/list -> 前缀换行的 pretty_repr（终端/文件显示）。DataFrame 由 _smart_log 单独处理。"""
    return '\n' + pretty_repr(
        data,
        indent_size=4,
        max_width=180,
        max_length=10,
        max_string=None,
        max_depth=5,
        expand_all=True,
    )


# 线程局部：_smart_log 存原始 dict/list/DataFrame，供 LogCollector 结构化采集
# （loguru 会 str 化 message，原始对象无法经 record 传递，故用线程局部）
_struct_local = threading.local()


def _smart_log(self, level, from_decorator, options, message, args, kwargs):
    if not args and (isinstance(message, (dict, list)) or _is_df(message)):
        # 提取 df 专用参数（避免 loguru 当 format 参数）
        title = kwargs.pop('title', None)
        max_lines = kwargs.pop('max_lines', 10)
        width = kwargs.pop('width', None)  # 默认 None，自动计算所需宽度，避免宽 DataFrame 被截断
        _struct_local.raw = message
        if _is_df(message):
            from helper.data_utils import _rich_df_str

            message = '\n' + _rich_df_str(message, title, max_lines, width)
        else:
            message = _format_for_display(message)
    return _orig_log(self, level, from_decorator, options, message, args, kwargs)


type(logger)._log = _smart_log


def _cleanup_old_logs(base_log_dir, max_age_days=30):
    """滚动清理 log/<程序名>/*.log 中超过 max_age_days 天未修改的日志文件"""
    if not os.path.isdir(base_log_dir):
        return
    cutoff = time.time() - max_age_days * 86400
    for prog_name in os.listdir(base_log_dir):
        prog_dir = os.path.join(base_log_dir, prog_name)
        if not os.path.isdir(prog_dir):
            continue
        for fname in os.listdir(prog_dir):
            if not fname.endswith('.log'):
                continue
            fpath = os.path.join(prog_dir, fname)
            try:
                if os.path.isfile(fpath) and os.path.getmtime(fpath) < cutoff:
                    os.remove(fpath)
            except OSError:
                pass


# 日志格式：级别名与消息按级别着色
Fmt = '{time:YYYY-MM-DD HH:mm:ss} | <level>{level:<8}</level> | <level>{message}</level>'

# INFO 不着色；其余级别沿用 loguru 默认配色（SUCCESS 绿 / WARNING 黄 / ERROR 红）
logger.level('INFO', color='')

# 默认配置：终端 + 文件输出
logger.remove()
logger.configure(patcher=_patch)
# 终端 sink 绑定到 stdout，与 print() 共享同一缓冲区，保证输出顺序一致
# colorize=None: tty 自动带色，重定向到文件/管道时自动关闭颜色，避免 ANSI 码污染
logger.add(sys.stdout, level='INFO', format=Fmt, colorize=None, backtrace=True, diagnose=True)

# 默认文件 sink：写到 <项目根>/log/<程序名>/YYYY-MM-DD_HH-MM-SS.log
# 程序名取 sys.argv[0] 文件名(去扩展名)，取不到时兜底 'app'
# 文件 sink 初始化失败不应阻断程序运行，降级为仅终端输出
try:
    _root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    # uvicorn 多 worker 场景：主进程首次 import 生成日志路径并写入环境变量 RTDBPY_LOG_FILE，
    # spawn 出的 worker 子进程继承该变量，复用同一文件，实现多 worker 共写一个日志文件
    _log_file = os.environ.get('RTDBPY_LOG_FILE')
    if not _log_file:
        _prog = os.path.splitext(os.path.basename(sys.argv[0]))[0] if sys.argv and sys.argv[0] else 'app'
        _log_dir = os.path.join(_root_dir, 'log', _prog)
        os.makedirs(_log_dir, exist_ok=True)
        _log_file = os.path.join(_log_dir, datetime.now().strftime('%Y-%m-%d_%H-%M-%S') + '.log')
        os.environ['RTDBPY_LOG_FILE'] = _log_file
    logger.add(_log_file, level='DEBUG', format=Fmt, encoding='utf-8', enqueue=True, backtrace=True, diagnose=True)
    # 滚动清理：删除 log/*/*.log 中 30 天未修改的日志
    _cleanup_old_logs(os.path.join(_root_dir, 'log'), 30)

    # 自定义 excepthook：uncaught exception 也记录到日志文件
    _orig_excepthook = sys.excepthook

    def _log_excepthook(exc_type, exc_value, exc_tb):
        logger.opt(exception=(exc_type, exc_value, exc_tb)).error('Uncaught exception')
        _orig_excepthook(exc_type, exc_value, exc_tb)

    sys.excepthook = _log_excepthook
except Exception as e:
    print(f'[helper/log] 默认文件日志初始化失败，仅终端输出: {e}', file=sys.stderr)


def setup_logger(log_dir=None, name='app', level='INFO', rotation='10 MB', retention='7 days', rotation_time=None):
    """配置日志：终端 + 可选文件输出。

    Args:
        log_dir: 日志文件目录，None 表示仅终端输出
        name: 日志文件名前缀
        level: 终端输出级别
        rotation: 日志轮转策略，默认 '10 MB'（按大小）
            - 按大小: '10 MB', '100 MB' 等
            - 按时间: '00:00'（每天午夜）, '12:00'（每天中午）等
        retention: 日志保留时间，默认 '7 days'
            - 支持: '7 days', '1 week', '1 month' 等
        rotation_time: 已废弃，请使用 rotation 参数（如 rotation='00:00' 表示午夜轮转）

    Returns:
        全局 logger 实例

    示例:
        # 按大小轮转（默认）
        setup_logger(log_dir='logs', name='app')

        # 按时间轮转（每天午夜）
        setup_logger(log_dir='logs', name='app', rotation='00:00')

        # 按时间轮转 + 保留 14 天
        setup_logger(log_dir='logs', name='app', rotation='00:00', retention='14 days')
    """
    # 兼容旧参数
    if rotation_time:
        rotation = rotation_time

    logger.remove()

    # 终端输出：绑定 stdout 与 print 共享缓冲区，保证顺序一致
    # colorize=None: tty 自动带色，重定向时自动关闭，避免 ANSI 码污染文件
    logger.add(sys.stdout, level=level, format=Fmt, colorize=None)

    # 文件输出
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
        log_file = os.path.join(log_dir, f'{name}_{{time:YYYY-MM-DD}}.log')
        logger.add(log_file, level='DEBUG', rotation=rotation, retention=retention, format=Fmt, encoding='utf-8', backtrace=True, diagnose=True, enqueue=True)

    return logger


def exception_logger(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception:
            logger.exception(f'{func.__name__} 执行失败')
            raise

    return wrapper


__all__ = ['logger', 'setup_logger', 'exception_logger']
