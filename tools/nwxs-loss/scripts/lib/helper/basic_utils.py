# 本文件包含的基础工具函数列表:
#
# 项目相关工具函数列表
# load_project_routers : 加载项目路由

# 装饰器与包装类
# calculate_time      : 装饰器，计算函数执行时间
# count               : 装饰器，统计函数调用次数和时间
# PicklableModule     : 可序列化的模块包装类
# SequentialTaskQueue : 串行任务队列类
# get_one_attr        : 从对象或字典中获取第一个匹配的属性值, 如果属性都不存在,返回默认值
# pick_array          : 从一个数组中，均匀抽取指定数量的子元素，返回新的数组

import importlib
import os
import queue
import threading
import time

# =============================================================================
# 1.项目相关工具
# =============================================================================


def short_str(s, n=100):
    if not isinstance(s, str):
        s = str(s)

    L = len(s)
    if L <= n * 2:
        return s

    return f'{s[:n]}...(len={L})...{s[-n:]}'


# 加载项目路由
def load_project_routers(app, project_name, projects_base_path='projects', prefix=''):
    project_import_path = f'{projects_base_path}.{project_name}'
    RTDBPY_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    while True:
        # 先尝试导入项目根目录的api
        try:
            # print(f'尝试导入{project_import_path}.api')
            # 动态导入子项目的 api.py
            api_module = importlib.import_module(f'{project_import_path}.api')
            # 将对应的 router 添加到 FastAPI 中
            app.include_router(api_module.router, prefix=prefix)
            logger.success(f'成功加载: {project_import_path}.api')
        except Exception:
            api_file = os.path.join(RTDBPY_ROOT, project_import_path.replace('.', '/'), 'api.py')
            if os.path.exists(api_file):
                logger.exception(f'加载子项目 api 失败: {project_import_path}.api')
        # 尝试从mconfig读取到当前子项目
        try:
            area = importlib.import_module(f'{project_import_path}.mconfig')
            if not area.cur_area or area.cur_area == '.':
                break
            project_import_path += f'.{area.cur_area}'
        except Exception:
            break


# =============================================================================
# 2. 装饰器和包装类
# =============================================================================


# 装饰器，计算函数执行时间
def calculate_time(func):
    # 包装函数
    def wrapper(*args, **kwargs):
        start_time = time.perf_counter()
        result = func(*args, **kwargs)
        end_time = time.perf_counter()
        execution_time = end_time - start_time
        logger.bind(step='TIME').info(f'[{func.__name__}] : {execution_time:.2f} s.')
        return result

    return wrapper


# 装饰器，统计函数调用次数和时间
def count(func):
    num = 0  # 初始化次数

    # 内部调用函数
    def call_fun(*args, **kwargs):
        nonlocal num  # 声明num 变当前作用域局部变量为最临近外层（非全局）作用域变量。
        start = time.time()  # 代码执行开始时间
        num += 1  # 每次调用次数加1
        res = func(*args, **kwargs)  # 原函数
        end = time.time()  # 代码执行结束时间
        longtime = end - start
        logger.bind(step='COUNT').info(f'\t {func.__name__} \t第 {num} 次调用，本次调用花费时间：{round(longtime, 3)}s')
        return res

    return call_fun


# 可序列化的模块包装类
class PicklableModule:
    # 初始化
    def __init__(self, module_name: str):
        self.module_name = module_name

    # 获取属性
    def __getattr__(self, item):
        # 惰性加载
        mod = importlib.import_module(self.module_name)
        return getattr(mod, item)

    # 获取状态
    def __getstate__(self):
        return self.module_name

    # 设置状态
    def __setstate__(self, state):
        self.module_name = state


import multiprocessing
import signal
import sys

from lib.helper.log import logger


class SequentialTaskQueue:
    def __init__(self, use_process=False, stop_on_error=True):
        """
        初始化任务队列
        :param use_process: True 使用子进程，False 使用子线程（默认）
        :param stop_on_error: True 如果任务出错则丢弃后续任务并停止（默认），False 出错继续执行
        """
        self.use_process = use_process
        self.stop_on_error = stop_on_error
        self.worker = None
        self.running = False
        self._logger = logger.bind(step='SequentialTaskQueue')  # ponytail: 缓存bound logger避免重复创建

        # 根据模式选择队列类型和工作器类型
        if self.use_process:
            self.q = multiprocessing.Queue()
            self._worker_cls = multiprocessing.Process
        else:
            self.q = queue.Queue()
            self._worker_cls = threading.Thread

        self._register_signals()

    def _register_signals(self):
        """注册系统中断信号 (仅在主线程有效)"""
        try:
            if threading.current_thread() is threading.main_thread():
                signal.signal(signal.SIGINT, self._signal_handler)
                signal.signal(signal.SIGTERM, self._signal_handler)
        except ValueError:
            pass

    def _signal_handler(self, sig, frame):
        """信号处理回调"""
        sig_name = 'CTRL+C' if sig == signal.SIGINT else 'SIGTERM'
        self._logger.info(f'捕获到信号 {sig_name}. 终止任务队列...')
        self.stop(wait=False)
        sys.exit(0)

    def add(self, func, *args, **kwargs):
        """添加任务到队列，若队列空闲则立即执行"""
        task_info = (func, args, kwargs)

        args_str = short_str(f'{args}')
        kwargs_str = short_str(f'{kwargs}')

        self._logger.info(f'开始添加任务: {func.__name__} | 参数: {args_str} {kwargs_str}')
        try:
            self.q.put(task_info)
        except Exception as e:
            logger.error(f'添加任务 {func.__name__} | 参数: {args_str} {kwargs_str} 报错: {e}')
            raise e
        self._logger.info(f'任务添加完成: {func.__name__} | 参数: {args_str} {kwargs_str}')

        # 如果工作器没有运行（初始状态或因之前的错误已停止），立即启动
        if self.worker is None or not self.worker.is_alive():
            self._logger.info('任务流未初始化或已停止，开始新任务流...')
            self._start_worker()

    def _start_worker(self):
        self.running = True
        self.worker = self._worker_cls(target=self._run, daemon=False)
        self.worker.start()

    def _run(self):
        """工作器的主循环"""
        while self.running:
            try:
                # 使用超时 get 来支持优雅停止 (每秒检查一次 running 标志)
                try:
                    task = self.q.get(timeout=1.0)
                except queue.Empty:
                    # 队列空，继续循环检查 running 标志
                    continue

                # 检查是否是停止信号（哨兵）
                if task is None:
                    break

                func, args, kwargs = task

                # 执行任务并获取结果状态
                success = self._execute_task(func, args, kwargs)

                # 如果任务失败且配置为出错停止，则清空队列并退出循环
                if not success and self.stop_on_error:
                    logger.error('[SequentialTaskQueue] 有任务出错，停止后面的任务。清空未执行的任务...')
                    self._clear_queue()
                    break

            except Exception as e:
                logger.error(f'[SequentialTaskQueue] 任务报错：{e}')
                break

        self.running = False
        self._logger.info('任务流停止.')

    def _execute_task(self, func, args, kwargs):
        """执行单个任务，返回 True(成功) 或 False(失败)"""
        print('-' * 50)
        logger.bind(step='Start').info(f'[SequentialTaskQueue] 任务开始执行: {func.__name__}')
        start_time = time.time()
        success = True

        try:
            func(*args, **kwargs)
        except Exception:
            success = False
            logger.error(f'[SequentialTaskQueue] 任务执行失败: {func.__name__}')
            args_str = short_str(f'{args}')
            kwargs_str = short_str(f'{kwargs}')
            logger.info(f'  Args: {args_str}')
            logger.info(f'  Kwargs: {kwargs_str}')
            logger.exception('任务执行异常')
        finally:
            end_time = time.time()
            duration = end_time - start_time
            logger.bind(step='End').info(f'[SequentialTaskQueue] 任务执行完成: {func.__name__}')
            logger.bind(step='Stats').info(f'[SequentialTaskQueue] 执行时间: {duration:.4f} 秒')
            print('-' * 50)

        return success

    def _clear_queue(self):
        """清空队列中剩余的任务"""
        count = 0
        while not self.q.empty():
            try:
                self.q.get_nowait()
                count += 1
            except queue.Empty:  # 兼容多进程队列可能的Empty异常
                break
        if count > 0:
            self._logger.info(f'已丢弃 {count} 个待处理任务.')

    def stop(self, wait=True, timeout=None):
        """
        停止任务队列
        :param wait: True-等待当前任务完成，False-立即停止
        :param timeout: 等待超时时间 (秒)，None-无限等待，0-不等待
        """
        if not self.worker or not self.worker.is_alive():
            return

        if wait:
            self._logger.info('等待所有任务流完成.')
            self.q.put(None)
            # 使用超时 join 避免无限等待
            self.worker.join(timeout=timeout)
            if self.worker.is_alive():
                logger.warning(f'[SequentialTaskQueue] 等待超时 ({timeout}s)，强制停止任务流.')
                if self.use_process:
                    self.worker.terminate()
                else:
                    self._clear_queue()
                self.worker.join(timeout=5)
        else:
            self._logger.info('立刻停止任务流 (wait=False).')
            if self.use_process:
                self.worker.terminate()
                self.worker.join()
                self._logger.info('任务流已终止.')
            else:
                self._clear_queue()
                self._logger.info('队列已清空。当前任务将完成，然后退出.')
                self.q.put(None)
                self.worker.join()

        self.worker = None
        self._logger.info('任务流已停止.')


# get_one_attr: 从对象或字典中获取第一个匹配的属性值, 如果属性都不存在,返回默认值
def get_one_attr(obj, *args, default=None):
    for k in args:
        # dict 情况
        if isinstance(obj, dict):
            if k in obj:
                return obj[k]
        else:
            # 对象情况
            if hasattr(obj, k):
                return getattr(obj, k)
    return default


# 从一个数组中，均匀抽取指定数量的子元素，返回新的数组
def pick_array(arr, k):
    n = len(arr)

    if k >= n:
        return arr[:]
    if k <= 0:
        return []

    res = []
    used = set()

    # 避免 k=1 时除零
    step = (n - 1) / (k - 1) if k > 1 else 0

    for i in range(k):
        idx = round(i * step)

        # 冲突修正：向两侧扩展
        offset = 0
        while idx in used:
            offset += 1
            right = idx + offset
            left = idx - offset

            if right < n and right not in used:
                idx = right
                break
            if left >= 0 and left not in used:
                idx = left
                break

        used.add(idx)
        res.append(arr[idx])

    return res


if __name__ == '__main__':
    # ----------------------------------------------------------------
    # 测试代码
    # ----------------------------------------------------------------

    def success_task(name):
        print(f"  -> Task '{name}' running...")
        time.sleep(1)
        print(f"  -> Task '{name}' success.")

    def fail_task(name):
        print(f"  -> Task '{name}' running...")
        time.sleep(1)
        raise RuntimeError(f"Task '{name}' CRASHED intentionally!")

    # 初始化：stop_on_error 默认为 True
    tq = SequentialTaskQueue(use_process=False, stop_on_error=True)

    print('=== 测试：任务链中断 ===')

    # 1. 正常任务
    tq.add(success_task, 'Job A (1/3)')

    # 2. 失败任务 (这将导致后面的 Job C 不执行)
    tq.add(fail_task, 'Job B (2/3 - Will Fail)')

    # 3. 被丢弃的任务
    tq.add(success_task, 'Job C (3/3 - Should be Skipped)')

    # 等待观察结果
    tq.stop(wait=True)

    print('\n=== 测试：重新添加任务 (Worker重启) ===')
    # 这里的任务应该能执行，因为 add 会重启 worker
    tq.add(success_task, 'Job D (New Batch)')
    tq.stop(wait=True)
