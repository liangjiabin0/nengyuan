# 本文件包含的时间与日期处理函数列表:
#
# get_day_begin                           : 获取指定时间戳所在日期的零点时间戳
# hm_str2int                              : 将 HH:MM 格式字符串转换为时间戳
# get_year_month                          : 获取时间戳对应的年月字符串(YYYYMM)
# get_day_num                             : 获取时间戳对应的日期(几号)
# get_month_num                           : 获取时间戳对应的月份
# get_year_num                            : 获取时间戳对应的年份
# get_month_day_count                     : 获取指定年月的天数
# get_previous_date                       : 获取前一天的日期字符串
# time_to_v_label                         : 将 HH:MM 时间转换为 v1-v96 标签
# get_query_val_field                     : 根据时间获取对应的字段名和日期
# get_last_day_begin_timestamp_for_month  : 获取指定月份最后一天的起始时间戳
# get_cur_time_str                        : 获取当前时间字符串
# get_time_array                          : 生成时间序列数组
# align_timestamp                         : 对齐时间戳
# get_time_slot_index                     : 获取时间槽索引
# get_minute_begin                        : 获取分钟开始时间戳
# date_range                              : 遍历日期数字范围

import calendar
import datetime as dt
import time
from datetime import date, datetime, timedelta
from typing import Iterator

# =============================================================================
# 1. 时间与日期处理
# =============================================================================


# 获取指定时间戳所在日期的零点时间戳
def get_day_begin(timestamp=int(time.time())):
    # 将时间戳转换为 datetime 对象
    if timestamp in [None, '', 0]:
        timestamp = int(time.time())
    day = dt.datetime.fromtimestamp(timestamp)

    # 获取该日期的0点时间（即00:00:00）
    midnight = day.replace(hour=0, minute=0, second=0, microsecond=0)

    # 将0点的时间转换回时间戳并返回
    return int(midnight.timestamp())


# 将 HH:MM 格式字符串转换为时间戳
def hm_str2int(hm_str, day=None):
    day_begin = get_day_begin(day)
    [hour, min] = [int(i) for i in hm_str.split(':')]
    return day_begin + hour * 60 * 60 + min * 60


# 获取时间戳对应的年月字符串(YYYYMM)
def get_year_month(timestamp):
    d = dt.datetime.fromtimestamp(timestamp)
    return d.strftime('%Y%m')


# 获取时间戳对应的日期(几号)
def get_day_num(timestamp):
    return dt.datetime.fromtimestamp(timestamp).day


# 获取时间戳对应的月份
def get_month_num(timestamp):
    return dt.datetime.fromtimestamp(timestamp).month


# 获取时间戳对应的年份
def get_year_num(timestamp):
    return dt.datetime.fromtimestamp(timestamp).year


# 获取指定年月的天数
def get_month_day_count(year, month):
    return calendar.monthrange(year, month)[1]


# 获取前一天的日期字符串
def get_previous_date(date_str):
    """
    根据输入的日期字符串，返回前一天的日期字符串。

    参数:
        date_str (str): 格式为 "YYYYMMDD" 的日期字符串。

    返回:
        str: 前一天的日期字符串，格式为 "YYYYMMDD"。
    """
    try:
        # 将字符串转换为 datetime 对象
        date_obj = dt.datetime.strptime(date_str, '%Y%m%d')

        # 计算前一天的日期
        previous_day = date_obj - datetime.timedelta(days=1)

        # 将前一天的日期转换为字符串
        previous_day_str = previous_day.strftime('%Y%m%d')

        return previous_day_str
    except ValueError as e:
        return f'输入日期格式错误: {e}'


# 将 HH:MM 时间转换为 v1-v96 标签
def time_to_v_label(time_str):
    try:
        # 解析输入时间
        time_parts = time_str.split(':')
        hours = int(time_parts[0])
        minutes = int(time_parts[1])

        # 计算时间在一天中的第几个 15 分钟段
        index = hours * 4 + minutes // 15

        # 检查是否在有效范围内
        if 0 <= index < 96:
            return f'v{index + 1}'
        else:
            return "时间超出范围，请输入有效的 'HH:MM' 格式时间。"
    except (ValueError, IndexError):
        return "时间格式错误，请使用 'HH:MM' 格式。"


# 根据时间获取对应的字段名和日期
def get_query_val_field(query_time, time_space: int):
    query_time = dt.datetime.strptime(query_time, '%Y-%m-%d %H:%M:%S')
    count = (query_time.hour * 60 + query_time.minute) // time_space
    query_day = int(
        dt.datetime(
            year=query_time.year,
            month=query_time.month,
            day=query_time.day,
            hour=0,
            minute=0,
            second=0,
        ).timestamp()
    )

    if count == 0:
        count += 1
    value_field = 'v%s' % count
    return value_field, query_day


# 获取指定月份最后一天的起始时间戳
def get_last_day_begin_timestamp_for_month(year, month):
    # 获取该月最后一天的日期
    last_day = calendar.monthrange(year, month)[1]
    last_day_datetime = dt.datetime(year, month, last_day)

    # 获取该天的最后一秒时间戳
    # last_second_timestamp = (last_day_datetime + datetime.timedelta(days=1) - datetime.timedelta(seconds=1)).timestamp()
    last_second_timestamp = int(last_day_datetime.timestamp()) + 1
    return int(last_second_timestamp)


# 获取当前时间字符串
def get_cur_time_str():
    return dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


# 生成时间序列数组
def get_time_array(start_time_str, end_time_str, delta_minite=15):
    time_format = '%Y-%m-%d %H:%M:%S'
    start_time = dt.datetime.strptime(start_time_str, time_format)
    end_time = dt.datetime.strptime(end_time_str, time_format)

    time_array = []
    current_time = start_time
    if start_time <= end_time:
        while current_time <= end_time:
            time_array.append(current_time.strftime(time_format))
            current_time += datetime.timedelta(minutes=delta_minite)
    else:
        while current_time >= end_time:
            time_array.append(current_time.strftime(time_format))
            current_time -= datetime.timedelta(minutes=delta_minite)

    return time_array


# 对齐时间戳
def align_timestamp(ts: float, interval: int) -> int:
    """
    将时间戳规整到 interval 秒的整数倍
    """
    return int(ts // interval * interval)


# 获取时间槽索引
def get_time_slot_index(
    interval_minutes: int,
    now=None,
    start_from_one: bool = False,
):
    """
    获取当前时间位于从 0 点开始的第几个 interval_minutes 时间点

    :param interval_minutes: 间隔分钟数，必须 > 0 且能整除 1440
    :param now: datetime，可选，默认使用当前时间
    :param start_from_one: 是否从 1 开始编号（默认 False，从 0 开始）
    :return: int
    """
    # ---------- 参数校验 ----------
    if not isinstance(interval_minutes, int) or interval_minutes <= 0:
        raise ValueError('interval_minutes 必须是正整数')

    if 1440 % interval_minutes != 0:
        raise ValueError(f'interval_minutes={interval_minutes} 无法整除 1440 分钟')

    if now is None:
        now = datetime.now()

    if not isinstance(now, datetime):
        raise TypeError('now 必须是 datetime 类型')

    # ---------- 核心计算 ----------
    minutes_since_midnight = now.hour * 60 + now.minute + now.second / 60

    index = int(minutes_since_midnight // interval_minutes)

    max_index = 1440 // interval_minutes - 1
    index = min(index, max_index)

    return index + 1 if start_from_one else index


# 获取分钟开始时间戳
def get_minute_begin(ts=None) -> int:
    """
    获取时间戳所在分钟的 0 秒时间戳（向下取整）

    :param ts: 秒级时间戳；None 表示当前时间
    :return: 秒级时间戳（int）
    """
    if ts is None:
        ts = time.time()

    # 统一转为 int 秒，防止 float 精度问题
    ts = int(ts)

    return ts - (ts % 60)


def date_range(a: int, b: int, step: int = 1) -> Iterator[int]:
    """
    类似 range(a, b+1)，遍历 %Y%m%d 格式的整数日期范围（包含 a 和 b）。

    Args:
        a:    起始日期，格式 %Y%m%d，如 20240101
        b:    结束日期，格式 %Y%m%d，如 20240110
        step: 步长（天数），默认 1；可为负数（此时 a 应大于 b）

    Yields:
        int: %Y%m%d 格式的整数日期

    Raises:
        ValueError: 日期格式非法，或 step 为 0
    """
    if step == 0:
        raise ValueError('step 不能为 0')

    def to_date(d: int) -> date:
        s = str(d)
        if len(s) != 8:
            raise ValueError(f'日期格式错误（需 8 位 %Y%m%d）：{d}')
        try:
            return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        except ValueError as e:
            raise ValueError(f'非法日期值 {d}：{e}')

    def to_int(d: date) -> int:
        return int(d.strftime('%Y%m%d'))

    start = to_date(a)
    end = to_date(b)
    delta = timedelta(days=step)

    cur = start
    while (step > 0 and cur <= end) or (step < 0 and cur >= end):
        yield to_int(cur)
        cur += delta
