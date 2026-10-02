# 本文件包含的数学与数据处理函数表:
# 数值处理
# safe_divide             : 安全除法，处理除零异常
# tof                     : value转为浮点数，如果不能转，就返回0
# is_number               : 判断字符串是否为数字
# normalize_number_string : 如果A是浮点数，删除结尾的0，如果是小数点后面都是0，则转换为整数
# process_value           : 如果参数是整数或浮点数或整数字符串或整数字符串，则直接返回，其他则两侧添加单引号后返回
# json_bigint_to_str      : 将 JSON 中的大整数转换为字符串
# parse_float             : 从字符串开头开始解析，遇到第一个非法字符就停止，而不是要求整个字符串都是合法数字。

# 算法与数学函数
# zw_method_to_zh         : 将计算方法代码转换为中文描述代码
# generate_noisy_curve    : 生成带噪声的曲线
# smooth_noisy_curve      : 平滑噪声曲线
# butterworth_filter      : 巴特沃斯低通滤波器
# resize_array            : 调整数组大小（插值）

# pandas dataframe处理函数
# compress_dataframe      : dataframe 压缩后转字符串
# decompress_to_dataframe : 压缩后字符串 转 dataframe
# pd_fillna_by_type       : 根据列类型填充 DataFrame 空值
# get_group               : 安全获取 DataFrame 分组
# read_big_csv_to_df      : 读取大 CSV 文件为 DataFrame
# print_df_table          : 使用 tabulate 打印 DataFrame
# dicts_to_df_fast        : 字典数组快速转为dataframe
# rows2d_to_pandas_fast   : 二维数组（rows）→ pandas
# df_dict_to_feather      : 将 DataFrame 字典保存为 Feather 文件
# df_dict_from_feather    : 从 Feather 文件读取 DataFrame 字典
# save_df                 : 最快dataframe写入文件的方法
# load_df                 : 最快dataframe读取文件的方法

# 数据结构转换函数
# proto_to_dict         : 将 Protobuf 对象转换为字典
# DotDict               : 支持点号访问的字典类
# mergin_dedup          : 合并两个列表并去重
# c_obj_arr_to_dict     : C++ struct数组 转 list<dict>
# c_obj_arr_to_df       : C++ struct数组 转 dataframe
# dict_to_c_object_arr  : list<dict>  转 C++ struct数组
# df_to_c_object_arr    : dataframe  转 C++ struct数组
# cfileinter_to_dict    : 将 CFileInter 对象转换为字典
# rename_key_keep_order : 重命名字典键并保持顺序
# module_to_obj         : 将模块转换为对象
# get_segment_list      : 将列表分段

# 绘图函数
# plot_char_chart            : 在命令行中输出折线图或柱状图


import base64
import io
import json
import lzma
import math
import os
import shutil
import time
import types

import numpy as np
import pandas as pd
from rich.box import Box
from rich.console import Console
from rich.table import Table

from lib.helper.log import logger

# =============================================================================
# 1. 数值处理
# =============================================================================


# 安全除法，处理除零异常
def safe_divide(a, b):
    try:
        return a / b
    except ZeroDivisionError:
        return 0


# value转为浮点数，如果不能转，就返回0
def tof(value, default=0.0):
    """
    value 转为 float
    - 不能转：返回 default
    - nan / inf / -inf：返回 default
    """
    try:
        v = float(value)
    except Exception:
        return default

    # 数值合法性校验
    if not math.isfinite(v):
        return default

    return v


# 判断字符串是否为数字
def is_number(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


# 如果A是浮点数，删除结尾的0，如果是小数点后面都是0，则转换为整数
def normalize_number_string(A):
    # 判断是否包含小数点
    if '.' in A:
        # 去除末尾的零
        A = A.rstrip('0').rstrip('.')
        # 如果小数点后面为空，说明是整数
        if A[-1] == '.':
            A = A[:-1]  # 移除可能的结尾点
    return A


# 如果参数是整数或浮点数或整数字符串或整数字符串，则直接返回，其他则两侧添加单引号后返回
def process_value(value):
    if isinstance(value, (int, float)):
        return str(value)
    elif isinstance(value, str):
        if value.isdigit() or (value.count('.') == 1 and all(char.isdigit() or char == '.' for char in value)):
            return str(value)
        else:
            return f"'{value}'"
    else:
        return f"'{value}'"


# 将 JSON 中的大整数转换为字符串
def json_bigint_to_str(dict_data):
    """
    将JSON数据中的bigint数字转为字符串
    :param data: 可以是dict/list/基本类型
    :return: 转换后的数据
    """
    if isinstance(dict_data, dict):
        return {k: json_bigint_to_str(v) for k, v in dict_data.items()}
    elif isinstance(dict_data, list):
        return [json_bigint_to_str(item) for item in dict_data]
    elif isinstance(dict_data, int) and abs(dict_data) > 2**53 - 1:  # JavaScript能表示的最大安全整数
        return str(dict_data)
    return dict_data


def division_0(a, b):
    if b == 0:
        return 0
    else:
        return round(float(a) / float(b), 4)


# =============================================================================
# 2. 算法与数学
# =============================================================================


# 将计算方法代码转换为中文描述代码
def zw_method_to_zh(method):
    if str(method) == '1':  # 原对偶内点法
        return '04'
    elif str(method) == '2':  # 信赖域法
        return '05'
    elif str(method) == '0':  # 修复算法
        return '06'
    elif str(method) == '3':  # 优化潮流
        return '07'
    elif str(method) == '4':  # bpa规划
        return '08'
    else:
        logger.error(f'Invalid calc method {method}, skip!')
        return None


# 生成带噪声的曲线
def generate_noisy_curve(y, type):
    if type == 'Gaussian':  # 高斯噪声
        noise_sigma = 0.0055
        noise = np.random.normal(0, noise_sigma, size=y.shape)
        y_noisy = y + noise
    elif type == 'Uniform':  # 均匀噪声
        noise_range = (-0.1, 0.2)  # 定义噪声的范围
        noise = np.random.uniform(low=noise_range[0], high=noise_range[1], size=y.shape)
        y_noisy = y + noise
    elif type == 'Exponential':  # 添加指数噪声
        scale = 0.25  # 指数分布的比例参数（λ的倒数，其中λ是率参数）
        noise = np.random.exponential(scale=scale, size=y.shape)
        y_noisy = y + noise
    else:
        y_noisy = y
    # 绘图
    # plt.plot(y, label='Original Curve')
    # plt.plot(y_noisy, label='Noisy Curve', linestyle='--')
    # plt.legend()
    # plt.show()
    return y_noisy


# 平滑噪声曲线
def smooth_noisy_curve(y, type):
    from scipy.ndimage import gaussian_filter
    from scipy.signal import savgol_filter

    if type == 'Savitzky-Golay':  # Savitzky-Golay滤波器
        window_length = 6  # 窗口大小
        polyorder = 2  # 多项式阶数
        y_smooth = savgol_filter(y, window_length, polyorder)
    elif type == 'Gaussian':  # 高斯滤波
        sigma = 0.5  # 标准差
        y_smooth = gaussian_filter(y, sigma=sigma)
    else:
        y_smooth = y
    # 绘图
    # plt.plot(y, label='Original with noise')
    # plt.plot(y_smooth, label='Smoothed')
    # plt.legend()
    # plt.show()
    return y_smooth


# 巴特沃斯低通滤波器
def butterworth_filter(data, cutoff_freq=0.1, sampling_freq=4, order=4, ensure_non_negative=True):
    from scipy import signal

    """
    使用Butterworth低通滤波器
    参数:
    - data: 输入数据，每行是一个96点曲线
    - cutoff_freq: 截止频率，决定通过的最高频率分量 (默认0.1)
    - sampling_freq: 采样频率，96点/天 = 4点/小时 (默认4)
    - order: 滤波器阶数，阶数越高滤波越陡峭 (默认4)
    - ensure_non_negative: 是否确保输出非负 (默认True)

    实例：
    # 1. 轻微滤波
    filtered_data = butterworth_filter(time_data, cutoff_freq=0.15)
    # 2. 强滤波 - 更平滑
    filtered_data = butterworth_filter(time_data, cutoff_freq=0.05, order=6)
    # 3. 弱滤波 - 保留更多细节
    filtered_data = butterworth_filter(time_data, cutoff_freq=0.25, order=2)
    # 4. 关闭非负保护
    filtered_data = butterworth_filter(time_data, ensure_non_negative=False)
    """

    # 计算归一化截止频率
    nyquist_freq = 0.5 * sampling_freq
    normal_cutoff = cutoff_freq / nyquist_freq

    # 检查截止频率是否有效
    if normal_cutoff <= 0 or normal_cutoff >= 1:
        logger.warning(f'归一化截止频率 {normal_cutoff:.4f} 超出有效范围 (0,1)，使用默认值0.1')
        normal_cutoff = 0.1 / nyquist_freq

    # 设计Butterworth滤波器
    try:
        b, a = signal.butter(order, normal_cutoff, btype='low', analog=False)
    except ValueError as e:
        logger.error(f'滤波器设计错误: {e}，使用较保守的参数')
        # 使用更保守的参数
        normal_cutoff = min(0.4, normal_cutoff * 0.5)  # 降低截止频率
        order = min(2, order)  # 降低阶数
        b, a = signal.butter(order, normal_cutoff, btype='low', analog=False)

    # 对数据进行滤波
    try:
        # 使用零相位滤波 (filtfilt) 避免相位失真
        filtered_data = signal.filtfilt(b, a, data)
        # 确保非负
        if ensure_non_negative:
            filtered_data = np.maximum(filtered_data, 0)
    except ValueError as e:
        logger.error(f'滤波错误: {e}，使用原始数据')
        return data

    return filtered_data.tolist()


# 调整数组大小（插值）
def resize_array(arr, M):
    arr = np.asarray(arr, dtype=float)
    N = len(arr)

    # 边界情况处理
    if N == 0:
        return np.zeros(M, dtype=float)
    if N == 1:
        return np.full(M, arr[0], dtype=float)

    # 生成目标采样点（均匀分布）
    x_old = np.linspace(0, 1, N)
    x_new = np.linspace(0, 1, M)

    # 线性插值
    new_arr = np.interp(x_new, x_old, arr)

    # 自动校验 & 修复
    if len(new_arr) != M:
        new_arr = np.resize(new_arr, M)

    return new_arr


# =============================================================================
# 3. Pandas DataFrame 处理
# =============================================================================


# dataframe 压缩后转字符串
def compress_dataframe(df: pd.DataFrame) -> str:
    """
    压缩 DataFrame 为字节流并转base64编码字符串
    :param df: 要压缩的 DataFrame
    :return: 压缩后的字符串(base64编码,方便打印到控制台)
    """
    csv_data = df.to_csv(index=False)

    # 可选使用gzip 或 lzma 算法import gzip
    # res_data = gzip.compress(csv_data.encode('utf-8'))
    res_data = lzma.compress(csv_data.encode('utf-8'), format=lzma.FORMAT_ALONE)
    res_data = base64.b64encode(res_data).decode('utf-8')

    return res_data


# 压缩后字符串 转 dataframe
def decompress_to_dataframe(compressed_data: str) -> pd.DataFrame:
    """
    解压缩字节流并恢复为 DataFrame
    :param compressed_data: 压缩后的base64字符串
    :return: 解压缩后的 DataFrame
    """
    try:
        compressed_data = base64.b64decode(compressed_data.encode('utf-8'))
        # decompressed_data = gzip.decompress(compressed_data).decode('utf-8')
        decompressed_data = lzma.decompress(compressed_data).decode('utf-8')
    except Exception as e:
        raise ValueError(f'Invalid encoded data: {e}')

    # 将解压缩后的 CSV 数据恢复为 DataFrame
    df_restored = pd.read_csv(io.StringIO(decompressed_data), dtype=str)

    return df_restored


# 简单打印 DataFrame
def _df_repr(df, max_lines=10):
    """返回 DataFrame 表格字符串（dfprint 同款格式），供 helper.log 复用，避免重复输出。"""
    with pd.option_context('display.max_rows', max_lines, 'display.max_columns', 100, 'display.expand_frame_repr', False):
        return str(df)


# 表头分隔粗线、数据行单线的混合 box：基于 ROUNDED（圆角单线外框 + 单线行间），
# 仅表头分隔行(head_row)用 HEAVY 粗线 ━（┡━╇┩ 为单竖+粗横，与 │ 衔接无错位）
_HEAVY_HEAD_BOX = Box(
    """\
╭─┬╮
│ ││
┡━╇┩
│ ││
├─┼┤
├─┼┤
│ ││
╰─┴╯
""",
    ascii=False,
)


# 用 rich.Table 打印 DataFrame，输出所有字段（列）
def _rich_df_str(df, title=None, max_lines=10, width=180):
    """生成纯文本 rich 表格字符串（no_color 无 ANSI），供 _smart_log/rich_print_df 复用。

    width=None 时自动取表头数据不换行所需宽度（Console.measure().maximum）。
    """
    table = Table(
        title=f'━━━ {title} ━━━' if title else None,
        title_style='bold black on yellow',
        title_justify='center',
        show_lines=True,
        expand=False,
        header_style='bold cyan',
        box=_HEAVY_HEAD_BOX,
    )
    for col in df.columns:
        # overflow='fold'：超宽内容换行显示，不截断丢失，确保字段内容完整
        table.add_column(str(col), overflow='fold', no_wrap=False)
    total = len(df)
    if max_lines is not None and total > max_lines:
        # 行数超限：首 half + 中间省略 ...(N行) + 尾 half
        half = max_lines // 2
        for i in range(half):
            table.add_row(*[str(v) for v in df.iloc[i]])
        omit = total - 2 * half
        cells = ['...'] * len(df.columns)
        cells[0] = f'...({omit}行)'
        table.add_row(*cells)
        for i in range(total - half, total):
            table.add_row(*[str(v) for v in df.iloc[i]])
    else:
        for row in df.itertuples(index=False, name=None):
            table.add_row(*[str(v) for v in row])
    if width is None:
        # 用大宽度 Console measure 取表格自然宽度（默认 Console 受终端宽度 cap，大表格会被截断成空）
        width = Console(width=2**15).measure(table).maximum
    buf = io.StringIO()
    Console(file=buf, no_color=True, width=width).print(table)
    return buf.getvalue().rstrip('\n')


def rich_print_df(df, title=None, max_lines=None, width=None):
    """用 rich.Table 打印 DataFrame，经 logger.info(_smart_log) 自动格式化。

    参数透传给 _rich_df_str（title/max_lines/width），原始 df 存线程局部供 LogCollector 采集 list<dict>。

    :param df: DataFrame
    :param title: 表格标题，默认 None
    :param max_lines: 最大显示行数，None 表示全部
    :param width: 表格宽度，None 表示自动取表头数据不换行宽度
    """
    logger.info(df, title=title, max_lines=max_lines, width=width)


# 根据列类型填充 DataFrame 空值
def pd_fillna_by_type(df):
    for col in df.columns:
        if pd.api.types.is_numeric_dtype(df[col]):
            df[col] = df[col].fillna(0)  # 数值型填0
        elif pd.api.types.is_string_dtype(df[col]):
            df[col] = df[col].fillna('')  # 字符型填''
        elif pd.api.types.is_bool_dtype(df[col]):
            df[col] = df[col].fillna(True)  # 布尔型填True
        else:
            df[col] = df[col].fillna(0)  # 其他类型填0


# 安全获取 DataFrame 分组
def get_group(df, key):
    try:
        return df.get_group(key)
    except KeyError:
        return None


# 读取大 CSV 文件为 DataFrame
def read_big_csv_to_df(filepath):
    import polars as pl

    begin = time.time()
    df = pl.read_csv(filepath, infer_schema_length=0).to_pandas()
    end = time.time()
    # 统计耗时秒
    logger.info(f'读取 {filepath} 耗时 {int(end - begin)}秒')

    return df


"""
| tablefmt       | 效果              | 备注             |
| -------------- | --------------- | -------------- |
| `"grid"`       | 经典边框，最严谨        | 我最推荐           |
| `"fancy_grid"` | Unicode 边框，非常好看 | 现代感强，会显示更流畅的线条 |
| `"github"`     | 类 Markdown      | 没有外边框          |
| `"psql"`       | PostgreSQL 风格   | 简洁但有线条         |
| `"mixed_grid"` | 混合线条风格          | 更紧凑            |

"""


# 使用 tabulate 打印 DataFrame
def print_df_table(df: pd.DataFrame, max_rows: int = 20, tablefmt='mixed_grid'):
    from tabulate import tabulate

    total = len(df)

    # 选取需要显示的部分
    if total > max_rows:
        half = max_rows // 2
        df_show = pd.concat([df.head(half), df.tail(half)])
    else:
        df_show = df

    # 打印表格
    logger.info(
        tabulate(
            df_show,
            headers='keys',
            tablefmt=tablefmt,  # grid: 带边框和分割线
            showindex=False,
        )
    )

    # 显示提示
    if total > max_rows:
        logger.info(f'... 共 {total} 行，仅显示前后各 {half} 行')


# 字典数组快速转为dataframe
def dicts_to_df_fast(records, columns=None, validate=False, to_pandas=False):
    """
    字典数组（字段一致）快速转 DataFrame（默认返回 polars.DataFrame）。
    - records: list[dict] 或可迭代；若是迭代器会被一次性消费成 list（不可避免）
    - columns: 指定列顺序（建议传，少走推断/重排弯路）
    - validate: True 会检查字段一致性（会多一次扫描，默认 False 保持最快）
    - to_pandas: True 则返回 pandas.DataFrame（注意：会明显变慢）
    """
    import polars as pl

    if records is None:
        df = pl.DataFrame(schema=columns or [])
        return df.to_pandas() if to_pandas else df

    if not isinstance(records, list):
        records = list(records)

    if len(records) == 0:
        df = pl.DataFrame(schema=columns or [])
        return df.to_pandas() if to_pandas else df

    if columns is None:
        # Python 3.7+ dict 保序：用第一条的 key 顺序作为列顺序
        columns = list(records[0].keys())

    if validate:
        keyset = set(columns)
        for i, r in enumerate(records):
            if set(r.keys()) != keyset:
                raise ValueError(f'第{i}条记录字段不一致：expected={columns}, got={list(r.keys())}')

    # schema 传 list[str] 可以固定列顺序；字段一致时很合适
    df = pl.DataFrame(records, schema=columns)

    return df.to_pandas() if to_pandas else df


# 二维数组（rows）→ pandas
def rows2d_to_pandas_fast(rows, columns, prefer_numpy=True):
    """
    rows: list[list] 或 np.ndarray (N×M)
    columns: 列名列表，长度必须等于 M
    prefer_numpy: 若 rows 是 list[list]，是否先转 np.array（很多场景更快）
    """
    import numpy as np

    if rows is None:
        return pd.DataFrame(columns=columns)
    if len(rows) == 0:
        return pd.DataFrame(columns=columns)

    # 边界校验
    m = len(columns)
    first = rows[0]
    if len(first) != m:
        raise ValueError(f'列数不匹配：columns={m}, row_len={len(first)}')

    if isinstance(rows, np.ndarray):
        return pd.DataFrame(rows, columns=columns)

    if prefer_numpy:
        arr = np.asarray(rows, dtype=object)  # 若全数值可改成 float/int dtype 更快更省内存
        return pd.DataFrame(arr, columns=columns)

    return pd.DataFrame(rows, columns=columns)


# 将 DataFrame 字典保存为 Feather 文件
def df_dict_to_feather(df_dict, dirpath):
    """
    将 {'a': df1, 'c': df2} 写入到指定目录
    - 若 dirpath 已存在：整体删除
    - 新建目录
    - 写入多个 feather
    - 生成 _manifest.json（包含生成时间）
    """
    # 强一致快照：先删再建
    if os.path.exists(dirpath):
        shutil.rmtree(dirpath)
    os.makedirs(dirpath, exist_ok=True)

    manifest = {'generated_at': int(time.time()), 'tables': {}}

    for key, df in df_dict.items():
        if not isinstance(df, pd.DataFrame):
            raise TypeError(f'key={key} 的值不是 pandas.DataFrame')

        fname = f'{key}.feather'
        fpath = os.path.join(dirpath, fname)

        # empty-safe
        df_to_save = df.head(0) if df.empty else df
        df_to_save.columns = [col.lower() for col in df_to_save.columns]
        df_to_save.reset_index(drop=True).to_feather(fpath)

        manifest['tables'][key] = {
            'file': fname,
            'rows': int(len(df)),
            'columns': list(df.columns),
            'dtypes': {c: str(df[c].dtype) for c in df.columns},
        }

    with open(os.path.join(dirpath, '_manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


# 从 Feather 文件读取 DataFrame 字典
def df_dict_from_feather(
    dirpath: str,
    *,
    keys=None,
    columns=None,
    return_meta: bool = False,
):
    """
    读取目录中的 feather

    return_meta=True 时：
        返回 (data_dict, manifest)
    """
    import json
    import os

    import pandas as pd

    manifest_path = os.path.join(dirpath, '_manifest.json')
    if not os.path.exists(manifest_path):
        raise FileNotFoundError(f'manifest 不存在: {manifest_path}')

    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    tables = manifest.get('tables', manifest)  # 兼容老结构
    result = {}

    for key, meta in tables.items():
        if keys is None or str(key) == str(keys) or key in list(keys):
            fpath = os.path.join(dirpath, meta['file'])
            if not os.path.exists(fpath):
                raise FileNotFoundError(f'{key} 对应的文件不存在: {fpath}')

            use_cols = None
            if columns is not None:
                use_cols = columns.get(key)

            df = pd.read_feather(fpath, columns=use_cols)

            if meta['rows'] == 0:
                df = df.head(0)

            result[key] = df

    if return_meta:
        return result, manifest
    return result


# 最快dataframe写入文件的方法
def save_df(df, filepath):
    from .system_utils import _is_pycharm

    if df is None or df.empty:
        logger.warning('DataFrame 为空，跳过保存')
        return

    # ===== PyCharm 环境：安全优先 =====
    if _is_pycharm():
        try:
            df.to_pickle(filepath)
            return
        except Exception as e:
            logger.error(f'PyCharm 写入失败: {e}')
            return

    # ===== CLI / 生产环境：性能优先 =====
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq

        table = pa.Table.from_pandas(df, preserve_index=False)
        pq.write_table(table, filepath)
    except Exception as e:
        logger.error(f'Parquet 写入失败: {e}')


# 最快dataframe读取文件的方法
def load_df(filepath):
    from .system_utils import _is_pycharm

    if not os.path.exists(filepath):
        logger.warning(f'文件不存在：{filepath}')
        return None

    # ===== PyCharm 环境：稳定优先 =====
    if _is_pycharm():
        try:
            # pandas 路径，避免直接操作 Arrow Table
            return pd.read_pickle(filepath)
        except Exception as e:
            logger.error(f'PyCharm 读取失败: {e}')
            return None

    # ===== CLI / 生产环境：性能优先 =====
    try:
        import pyarrow.parquet as pq

        table = pq.read_table(filepath)
        df = table.to_pandas()
        return df
    except Exception as e:
        logger.error(f'Parquet 读取失败: {e}')
        return None


# =============================================================================
# 4. 数据结构转换
# =============================================================================


# 将 Protobuf 对象转换为字典
def proto_to_dict(proto):
    res = {}
    for i in proto.ListFields():
        res[i[0].name] = i[1]
    return res


# 支持点号访问的字典类
class DotDict(dict):
    """dot.notation access to dictionary attributes"""

    # 获取属性
    def __getattr__(self, attr):
        return self.get(attr)

    __setattr__ = dict.__setitem__
    __delattr__ = dict.__delitem__


# 合并两个列表并去重
def mergin_dedup(a1, a2, exclude=[]):
    res = []
    for i in a1:
        if i not in res:
            if i not in exclude:
                res.append(i)
    for i in a2:
        if i not in res:
            if i not in exclude:
                res.append(i)
    return res


# C++ struct数组 转 list<dict>
def c_obj_arr_to_dict(objs, l, begin=1):
    res = []
    for i in range(begin, l):
        r = {}
        for j in objs[i]._dtype.names:
            j = j.replace('$', '_')
            r[j] = getattr(objs[i], j)
            if r[j] == '\x00':
                r[j] = ''
        res.append(r)
    return res


# C++ struct数组 转 dataframe
def c_obj_arr_to_df(objs, l, begin=1):
    dtype = {}
    if l > 0:
        fields = dict(objs[begin]._dtype.fields)
        for i in fields:
            if fields[i][0].name.startswith('int'):
                dtype[i] = 'I' + fields[i][0].name[1:]
            elif fields[i][0].name.startswith('float'):
                dtype[i] = 'F' + fields[i][0].name[1:]
            elif fields[i][0].name.startswith('bytes'):
                dtype[i] = 'string'
            elif fields[i][0].name == 'bool':
                dtype[i] = 'boolean'
            else:
                raise Exception(f'unknown type {fields[i][0].name}')
    else:
        return pd.DataFrame({})

    res = pd.DataFrame({}, columns=dtype.keys())
    res = res.astype(dtype)

    for i in range(begin, l):
        r = {}
        for j in objs[i]._dtype.names:
            r[j] = getattr(objs[i], j.replace('$', '_'))
            if r[j] == '\x00':
                r[j] = ''
        res.loc[i - 1] = r
    return res


# list<dict>  转 C++ struct数组
def dict_to_c_object_arr(d, objs):
    for index, row in enumerate(d):
        for i in row:
            if row[i] == '':
                setattr(objs[index + 1], i.replace('$', '_'), '\x00')
            else:
                setattr(objs[index + 1], i.replace('$', '_'), row[i])
    return len(d) + 1


# dataframe  转 C++ struct数组
# 执行完该函数后，需要紧接着将 返回值赋值 给 lv_*
def df_to_c_object_arr(df, objs):
    for index, row in df.iterrows():
        for i in row.keys():
            if row[i] == '':
                setattr(objs[index + 1], i.replace('$', '_'), '\x00')
            else:
                setattr(objs[index + 1], i.replace('$', '_'), row[i])
    return len(df) + 1


# 将 CFileInter 对象转换为字典
def cfileinter_to_dict(cefile):
    from config import USE_PYBIND

    moudle_ptr = cefile.GetModPtrArr()[0] if USE_PYBIND else cefile.GetModPtrArr()
    result = {}
    # 遍历得到每个表的数据
    for module in moudle_ptr:
        c_table = module[0] if USE_PYBIND else module
        table_name = c_table.GetName()

        nrow, ncol = c_table.GetRows(), c_table.GetCols()

        result[table_name] = {
            'fields': [],
            'data': [],
            'nrow': nrow,
            'ncol': ncol,
        }

        c_table = cefile.GetModulePtrByName(table_name)[0] if USE_PYBIND else cefile.GetModulePtrByName(table_name)

        # 得到列名
        for col in range(ncol):
            result[table_name]['fields'].append(c_table.GetColName(col))

        if nrow > 0:
            from concurrent.futures import ThreadPoolExecutor

            max_works = os.cpu_count() - 1
            batch_size = max(1, nrow // max_works)

            # 处理行数据
            def process_row(begin):
                data = []
                for row in range(begin, min(begin + batch_size, nrow)):
                    efileinter_row = c_table.GetRow(row)
                    data.extend([[efileinter_row.GetValue(col) for col in range(ncol)]])
                return data

            with ThreadPoolExecutor(max_workers=max_works) as executor:
                # 分批处理避免内存峰值
                for res in executor.map(process_row, range(0, nrow, batch_size)):
                    result[table_name]['data'].extend(res)

    return result


# 重命名字典键并保持顺序
def rename_key_keep_order(d: dict, old_key: str, new_key: str) -> dict:
    new_dict = {}
    for k, v in d.items():
        if k == old_key:
            new_dict[new_key] = v
        else:
            new_dict[k] = v
    return new_dict


# 将模块转换为对象
def module_to_obj(module):
    # 将模块（如config.py）转化为对象，从而得到一个该模块的可复制对象，支持通过`.`来访问模块下的变量
    return types.SimpleNamespace(**vars(module))


# 将列表分段
def get_segment_list(source_list, segment_count):
    """将list分成多段"""
    return [source_list[i : i + segment_count] for i in range(0, len(source_list), segment_count)]


# =============================================================================
# 4. 绘图函数 plot_char_chart
# =============================================================================


def _calculate_nice_ticks(data_min, data_max, num_ticks=5):
    """
    计算漂亮的纵坐标刻度（类似 ECharts 的算法）

    参数:
    - data_min: 数据最小值
    - data_max: 数据最大值
    - num_ticks: 期望的刻度数量（优先5个，范围3-5个）

    返回:
    - (ticks, min_val, max_val): 刻度列表、最小刻度、最大刻度
    """
    import math

    if data_min == data_max:
        if data_min == 0:
            return [0, 0.25, 0.5, 0.75, 1.0], 0, 1.0
        else:
            abs_val = abs(data_min)
            if abs_val < 1e-10:
                return [0], 0, 0
            magnitude = 10 ** math.floor(math.log10(abs_val))
            nice_min = math.floor(data_min / magnitude) * magnitude
            nice_max = nice_min + magnitude
            return [nice_min, (nice_min + nice_max) / 2, nice_max], nice_min, nice_max

    data_range = data_max - data_min

    if data_range < 1e-10:
        return [data_min], data_min, data_min

    magnitude = 10 ** math.floor(math.log10(data_range))

    nice_intervals = [magnitude * i for i in [1, 2, 2.5, 4, 5, 10, 20, 25, 40, 50]]

    best_ticks = None
    best_score = float('inf')

    for interval in nice_intervals:
        nice_min = math.floor(data_min / interval) * interval
        nice_max = math.ceil(data_max / interval) * interval

        num_intervals = round((nice_max - nice_min) / interval)
        num_ticks_candidate = num_intervals + 1

        if 3 <= num_ticks_candidate <= 5:
            ticks = []
            current = nice_min
            while current <= nice_max + 1e-10:
                ticks.append(current)
                current += interval

            score = abs(num_ticks_candidate - 5) * 10

            for tick in ticks:
                tick_str = f'{tick:.10f}'.rstrip('0').rstrip('.')
                if tick_str.endswith('0') or tick_str.endswith('5'):
                    score -= 1

            if score < best_score:
                best_score = score
                best_ticks = ticks

    if best_ticks is not None:
        return best_ticks, best_ticks[0], best_ticks[-1]

    magnitude = 10 ** math.floor(math.log10(data_range))

    residual = data_range / magnitude
    nice_interval = None

    if residual <= 1.5:
        nice_interval = magnitude * 1
    elif residual <= 3:
        nice_interval = magnitude * 2
    elif residual <= 7:
        nice_interval = magnitude * 5
    else:
        nice_interval = magnitude * 10

    nice_min = math.floor(data_min / nice_interval) * nice_interval
    nice_max = math.ceil(data_max / nice_interval) * nice_interval

    ticks = []
    current = nice_min
    while current <= nice_max + 1e-10:
        ticks.append(current)
        current += nice_interval

    if len(ticks) > 5:
        interval_2 = nice_interval * 2
        ticks = []
        current = math.floor(data_min / interval_2) * interval_2
        while current <= nice_max + 1e-10:
            ticks.append(current)
            current += interval_2

    if len(ticks) < 2:
        ticks = [nice_min, nice_max]

    return ticks, nice_min, nice_max


def _format_tick_value(value):
    """
    格式化刻度值为漂亮的字符串

    参数:
    - value: 刻度值

    返回:
    - 格式化后的字符串
    """
    import math

    if value == 0:
        return '0'

    abs_val = abs(value)

    if abs_val >= 1000000:
        exp = int(math.floor(math.log10(abs_val)))
        mantissa = value / (10**exp)
        if abs(mantissa - round(mantissa)) < 1e-10:
            return f'{int(mantissa)}e{exp}'
        return f'{mantissa:.1f}e{exp}'

    if abs_val < 0.001:
        exp = int(math.floor(math.log10(abs_val)))
        mantissa = value / (10**exp)
        if abs(mantissa - round(mantissa)) < 1e-10:
            return f'{int(mantissa)}e{exp}'
        return f'{mantissa:.1f}e{exp}'

    if abs_val >= 100:
        return f'{int(round(value))}'

    if abs_val >= 1:
        if abs(value - round(value)) < 1e-10:
            return f'{int(round(value))}'
        return f'{value:.1f}'

    if abs_val >= 0.01:
        if abs(value * 100 - round(value * 100)) < 1e-10:
            return f'{value:.2f}'
        return f'{value:.3f}'

    if abs_val >= 0.001:
        return f'{value:.4f}'

    exp = int(math.floor(math.log10(abs_val)))
    mantissa = value / (10**exp)
    return f'{mantissa:.1f}e{exp}'


# 在命令行中输出多条折线图或柱状图
def plot_char_chart(data, y_cols=None, x_col=None, chart_type='line', title=None, split=None):
    """
    在命令行中输出多条折线图或柱状图（字符版）

    参数:
    - data: 数据，支持两种格式：
      * JSON格式：{'title': 'xxx', 'x': [], 'y': [[], [], ...]}
        说明：y 可以是 1 到多个曲线的数据
      * DataFrame：pandas DataFrame
    - y_cols: y轴数据来源（仅DataFrame有效，不能为空）
      * 字符串列表：使用指定列名列表（1到多个）
      * 整数列表：使用指定列索引列表（1到多个）
    - x_col: x轴数据来源（仅DataFrame有效）
      * None：使用 DataFrame 的 index
      * 字符串：使用指定列名
      * 整数：使用指定列索引
    - chart_type: 图表类型，'line' 为折线图，'bar' 为柱状图，默认为 'line'
    - title: 图表标题（仅DataFrame有效，默认为None不显示标题）
      * None：不显示标题
      * 非空字符串：使用指定的字符串作为标题
    - split: 切分长度，None表示不切分，24表示每24个数据点切分一次

    示例:
    >>> # JSON格式
    >>> data = {'title': '多曲线数据', 'x': ['一月', '二月', '三月'], 'y': [[100, 200, 150], [80, 150, 120]]}
    >>> plot_char_chart(data)

    >>> # DataFrame格式
    >>> import pandas as pd
    >>> df = pd.DataFrame({'月份': ['一月', '二月', '三月'], '销量A': [100, 200, 150], '销量B': [80, 150, 120]})
    >>> plot_char_chart(df, y_cols=['销量A', '销量B'], x_col='月份', title='多曲线销售')
    """
    import pandas as pd

    title_param = title
    title = None
    x = []
    y_list = []

    if isinstance(data, pd.DataFrame):
        if title_param is not None and title_param != '':
            title = title_param

        if y_cols is None:
            logger.error('y_cols 参数不能为空，请指定要绘制的列')
            return

        if x_col is None:
            x = data.index.tolist()
        elif isinstance(x_col, str):
            if x_col in data.columns:
                x = data[x_col].tolist()
            else:
                logger.error(f'列名 "{x_col}" 不存在于 DataFrame 中')
                return
        elif isinstance(x_col, int):
            if 0 <= x_col < len(data.columns):
                x = data.iloc[:, x_col].tolist()
            else:
                logger.error(f'列索引 {x_col} 超出范围')
                return
        else:
            logger.error('x_col 参数类型错误，应为 None、字符串或整数')
            return

        if isinstance(y_cols, list):
            for y_col in y_cols:
                if isinstance(y_col, str):
                    if y_col in data.columns:
                        y_list.append(data[y_col].tolist())
                    else:
                        logger.error(f'列名 "{y_col}" 不存在于 DataFrame 中')
                        return
                elif isinstance(y_col, int):
                    if 0 <= y_col < len(data.columns):
                        y_list.append(data.iloc[:, y_col].tolist())
                    else:
                        logger.error(f'列索引 {y_col} 超出范围')
                        return
                else:
                    logger.error('y_cols 列表元素类型错误，应为字符串或整数')
                    return
        else:
            logger.error('y_cols 参数类型错误，应为列表')
            return

        for i in range(len(y_list)):
            y_list[i] = [float(val) if not isinstance(val, (int, float)) else val for val in y_list[i]]
    else:
        title = data.get('title', '图表')
        x = data.get('x', [])
        y_list = data.get('y', [])

        if not isinstance(y_list, list) or not all(isinstance(y, list) for y in y_list):
            logger.error('y 应该是列表的列表，例如 [[100, 200], [80, 150]]')
            return

    if not y_list:
        logger.error('没有y轴数据')
        return

    for y in y_list:
        if len(x) != len(y):
            logger.error(f'x和y的长度不一致: x长度={len(x)}, y长度={len(y)}')
            return

    if len(x) == 0:
        logger.error('数据为空')
        return

    if chart_type not in ['line', 'bar']:
        logger.error(f'不支持的图表类型: {chart_type}，请使用 "line" 或 "bar"')
        return

    all_y = [val for y in y_list for val in y]
    data_min = min(all_y) if all_y else 0
    data_max = max(all_y) if all_y else 1

    global_ticks, global_nice_min, global_nice_max = _calculate_nice_ticks(data_min, data_max)

    if global_nice_max == global_nice_min:
        global_nice_range = 1
    else:
        global_nice_range = global_nice_max - global_nice_min

    chart_height = 20

    line_symbols = ['●', '+', '○', '◆', '◇', '★', '☆', '▲', '△']
    bar_symbols = ['██', '##', '▓▓', '//', '■■', '□□', '◆◆', '●●', '★★', '▲▲', '▼▼']

    def draw_single_chart(sub_title, sub_x, sub_y_list, use_global_scale=True):
        if sub_title is not None:
            logger.info(f'\n{sub_title}')
            logger.info('=' * len(sub_title))

        if chart_type == 'line':
            col_width = len(sub_y_list) + 2
        else:
            col_width = len(sub_y_list) * 2 + 2

        x_mapping = {}
        x_display = []

        for i, label in enumerate(sub_x):
            label_str = str(label)
            if any('\u4e00' <= c <= '\u9fff' for c in label_str) or len(label_str) > 4:
                short_label = f'X{i + 1}'
                x_mapping[short_label] = label_str
                x_display.append(short_label)
            else:
                short_label = label_str[: col_width - 1]
                x_display.append(short_label)

        if use_global_scale:
            ticks = global_ticks
            nice_min = global_nice_min
            nice_max = global_nice_max
            nice_range = global_nice_range
        else:
            sub_min = min([val for y in sub_y_list for val in y]) if sub_y_list else 0
            sub_max = max([val for y in sub_y_list for val in y]) if sub_y_list else 1

            ticks, nice_min, nice_max = _calculate_nice_ticks(sub_min, sub_max)

            if nice_max == nice_min:
                nice_range = 1
            else:
                nice_range = nice_max - nice_min

        tick_labels = [_format_tick_value(t) for t in ticks]
        y_label_width = max(len(label) for label in tick_labels) if tick_labels else 5

        tick_rows = {}
        for i, tick in enumerate(ticks):
            if nice_range == 0:
                row = chart_height
            else:
                row = round((tick - nice_min) / nice_range * chart_height)
            tick_rows[row] = tick_labels[i]

        for row in range(chart_height, -1, -1):
            if row in tick_rows:
                y_label = tick_rows[row]
            else:
                y_label = ' ' * y_label_width

            line = f'{y_label:>{y_label_width}} |'

            if chart_type == 'bar':
                for col_idx in range(len(sub_x)):
                    col_str = ''
                    for y_idx, y in enumerate(sub_y_list):
                        val = y[col_idx]
                        if nice_range == 0:
                            bar_height = chart_height
                        else:
                            bar_height = round((val - nice_min) / nice_range * chart_height)
                        if row <= bar_height:
                            symbol = bar_symbols[y_idx % len(bar_symbols)]
                            col_str += symbol
                        else:
                            col_str += '  '
                    line += col_str + '  '
            else:
                for col_idx in range(len(sub_x)):
                    col_str = ''
                    for y_idx, y in enumerate(sub_y_list):
                        val = y[col_idx]
                        if nice_range == 0:
                            point_height = chart_height
                        else:
                            point_height = round((val - nice_min) / nice_range * chart_height)
                        if row == point_height:
                            symbol = line_symbols[y_idx % len(line_symbols)]
                            col_str += symbol
                        else:
                            col_str += ' '
                    line += col_str + '  '

            logger.info(line)

        logger.info(' ' * y_label_width + ' +' + '-' * (len(sub_x) * col_width))
        logger.info(' ' * y_label_width + '  ', end='')

        for label in x_display:
            logger.info(f'{label:^{col_width}}', end='')
        logger.info('')

        if x_mapping:
            logger.info('\n横轴标签映射:')
            mapping_items = list(x_mapping.items())
            if len(mapping_items) > 10:
                for short, full in mapping_items[:2]:
                    logger.info(f'  {short} = {full}')
                logger.info('  ...')
                short, full = mapping_items[-1]
                logger.info(f'  {short} = {full}')
            else:
                for short, full in mapping_items:
                    logger.info(f'  {short} = {full}')

        if len(sub_y_list) > 1:
            logger.info('\n曲线符号:')
            for i, y in enumerate(sub_y_list):
                if chart_type == 'line':
                    symbol = line_symbols[i % len(line_symbols)]
                else:
                    symbol = bar_symbols[i % len(bar_symbols)]
                logger.info(f'  {symbol} = 曲线{i + 1}')

    if split is None or len(x) <= split:
        draw_single_chart(title, x, y_list, use_global_scale=False)
    else:
        num_chunks = (len(x) + split - 1) // split
        for i in range(num_chunks):
            start_idx = i * split
            end_idx = min((i + 1) * split, len(x))
            sub_x = x[start_idx:end_idx]
            sub_y_list = [y[start_idx:end_idx] for y in y_list]
            if title is not None:
                sub_title = f'{title} ({i + 1}/{num_chunks})'
            else:
                sub_title = None
            draw_single_chart(sub_title, sub_x, sub_y_list, use_global_scale=True)

    logger.info(f'\n数据范围: {min(all_y):.2f} ~ {max(all_y):.2f}')


# 从字符串开头开始解析，遇到第一个非法字符就停止，而不是要求整个字符串都是合法数字。
# print(parse_float("220kv"))         # 220.0
# print(parse_float("12.34px"))       # 12.34
# print(parse_float("  -5.2abc"))     # -5.2
# print(parse_float(".5rem"))         # 0.5
# print(parse_float("1.2e3abc"))      # 1200.0
# print(parse_float("abc123"))        # None
def parse_float(s: str):
    import re

    _pattern = re.compile(r'^\s*([+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)')

    match = _pattern.match(str(s))
    return float(match.group(1)) if match else None
