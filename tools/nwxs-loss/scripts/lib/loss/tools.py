import os
import sys

# 设置路径
CUR_PATH = os.path.abspath(os.path.dirname(__file__))
lib_dir = os.path.dirname(CUR_PATH)
if lib_dir not in sys.path:
    sys.path.insert(0, lib_dir)

import datetime
import json
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

import pandas as pd

from lib.helper.log import logger

table_schema = {}

table_schema_path = os.path.join(CUR_PATH, 'tables_schema.json')
if os.path.exists(table_schema_path):
    table_schema = json.load(open(table_schema_path))
    logger.success(f'load {table_schema_path}')


def get_table_schema(table_name):
    global table_schema

    if table_name.startswith('tmp_'):
        table_name = '_'.join(table_name.split('_')[1:-1])

    if table_name in table_schema:
        return table_schema[table_name]
    else:
        def_table_schema_path = os.path.join(CUR_PATH, 'tables_schema_for_dms_taiqu.json')
        def_table_schema = {}
        if os.path.exists(def_table_schema_path):
            def_table_schema = json.load(open(def_table_schema_path))
        if table_name in def_table_schema:
            return def_table_schema[table_name]
        else:
            raise Exception(f'{table_name} is not in tables_schema.json and tables_schema_for_dms_taiqu.json, please run gen_tables_schema_json()')


# pandas的astype
def get_table_astype_pd(table):
    schema = get_table_schema(table)
    type_mapping = {
        'bigint': 'int64',
        'int': 'int32',
        'string': 'str',
        'varchar': 'str',
        'boolean': 'bool',
        'float': 'float32',
        'double': 'float64',
        'decimal': 'decimal',  # DECIMAL类型可以根据精度选择 float 或 object
        'date': 'date',
        'datetime': 'datetime',
        'timestamp': 'timestamp',
        'binary': 'object',
        'array': 'list',
        'map': 'dict',
        'varchar(255)': 'str',
        'varchar(84)': 'str',
        'varchar(64)': 'str',
        'tinyint': 'int32',
    }

    res = {i: type_mapping[schema[i]] for i in schema}

    return res


def get_dll_name(name):
    if os.name == 'nt':
        return name + '.dll'
    else:
        return 'lib' + name + '.so'


def get_lib_dir(dir):
    if os.name == 'nt':
        lib_dir = Path(dir) / 'bin'
    else:
        lib_dir = Path(dir) / 'lib'
    return lib_dir


# 分割可能是连续空格，单个逗号，连续缩进的组合， 遇到引号包裹的字符串不进行分割
def custom_split(input_string):
    # 使用 shlex.split() 函数进行分割
    parts = shlex.split(input_string)

    # 去除单引号
    parts = [part.strip("'") for part in parts]

    return parts


def read_cime_file(filename, encoding='GBK'):
    res = {}
    with open(filename, encoding=encoding, errors='ignore') as file:
        table_name = None
        for line_number, line in enumerate(file, start=1):
            if line:
                if line.strip():
                    line = custom_split(line.strip())
                    line = [None if line_value == "''" else line_value for line_value in line]
                    if line[0].startswith('@') and table_name:
                        if len(line[0]) > 1:
                            res[table_name]['header'] = [line[0].replace('@', '')]
                            res[table_name]['header'] += line[1:]
                        else:
                            res[table_name]['header'] = line[1:]
                    elif line[0] == '#' and table_name:
                        res[table_name]['data'].append(line[1:])
                    else:
                        match = re.search(r'^\s*<(/?)(.*)>\s*$', line[0])
                        if match:
                            if match.group(1):
                                table_name = None
                            else:
                                table_name = match.group(2)
                                if table_name not in res:
                                    res[table_name] = {'header': [], 'data': []}

    return res


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


def calculate_time(func):
    def wrapper(*args, **kwargs):
        start_time = time.perf_counter()
        result = func(*args, **kwargs)
        end_time = time.perf_counter()
        execution_time = end_time - start_time
        print(f'[{func.__name__}] : {execution_time:.2f} s.')
        return result

    return wrapper


def _S(a):
    try:
        if str(a) in ['nan', 'None', 'NULL', 'null']:
            return 'NULL'
        else:
            if float(a) == a:
                return str(a)
            else:
                return f"'{a}'"
    except:
        return f"'{a}'"


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


processes_map = {}


def run_command(cmd, cwd, repeat=True, logout=False):
    """
    使用 subprocess 启动一个子进程并等待执行结果

    参数:
        cmd (list or str): 要执行的命令。可以是字符串形式的 shell 命令，也可以是命令和参数列表。
        cwd (str): 工作目录路径
        repeat (bool): 是否允许重复执行相同的命令。默认为 True。

    返回:
        tuple: (stdout, stderr, returncode) 分别为标准输出、标准错误和退出码
    """
    start_time = time.time()
    global processes_map
    cmd_str = cmd if isinstance(cmd, str) else ' '.join(cmd)
    if cmd_str in processes_map and not repeat:
        print(f'Process {cmd_str} already exists. Skip it.')
        return None, None, 10086

    print(f'Start running command {cmd} in {cwd}')
    processes_map[cmd_str] = True  # 使用布尔值表示命令正在执行

    try:
        if isinstance(cmd, str):
            result = subprocess.run(cmd, shell=True, capture_output=True, cwd=cwd)
        else:
            result = subprocess.run(cmd, capture_output=True, cwd=cwd)

        stdout, stderr = result.stdout, result.stderr
        returncode = result.returncode

        # 将二进制输出转换为字符串
        try:
            stdout = stdout.decode('utf-8').strip()
            stderr = stderr.decode('utf-8').strip()
        except Exception:
            try:
                stdout = stdout.decode('gbk').strip()
                stderr = stderr.decode('gbk').strip()
            except Exception:
                try:
                    stdout = stdout.decode().strip()
                    stderr = stderr.decode().strip()
                except Exception:
                    pass
        if logout:
            print(f'Stdout: {stdout}')
            print(f'Stderr: {stderr}', file=sys.stderr)
        print(f'Command {cmd_str} completed with exit code {returncode}.')

        # if returncode != 0:
        #     raise Exception(f'Command {cmd_str} failed with exit code {returncode}. Stderr: \n{stderr}')
        print(f'Command {cmd_str} cost {time.time() - start_time:.2f} s.')
        return stdout, stderr, returncode
    finally:
        # 确保命令完成后从 processes_map 中移除
        del processes_map[cmd_str]


def delete_expire_files(folder, expire_days=30, file_type=None):
    """
    删除指定文件夹中所有过期文件，过期时间为当前时间减去指定天数
    """
    now = datetime.datetime.now()
    files = os.listdir(folder)
    files = [file for file in files if file_type is None or file.endswith(file_type)]
    if len(files) < expire_days:
        return
    for filename in files:
        file_path = os.path.join(folder, filename)
        if os.stat(file_path).st_mtime < (now - datetime.timedelta(days=expire_days)).timestamp():
            os.remove(file_path)


def real_to_his(engine_real, engine_his, table, sp_time, clear_other_day=False):
    from sqlalchemy import text

    with engine_real.begin() as conn:
        res = conn.execute(text(f'SHOW COLUMNS FROM  `{table}`')).fetchall()
        fields = []
        updates = []
        for i in res:
            fields.append(f'`{i[0]}`')
            updates.append(f'`{i[0]}` = VALUES(`{i[0]}`)')

        if '`SP_TIME`' in fields:
            del fields[fields.index('`SP_TIME`')]

        fields = ','.join(fields)
        updates = ','.join(updates)

        if clear_other_day:
            conn.execute(text(f'delete from `{engine_his.url.database}`.`{table}` where SP_TIME != {get_day_begin(sp_time)}'))

        sql = (
            f'insert into {engine_his.url.database}.{table} (SP_TIME, {fields}) '
            f'select {get_day_begin(sp_time)} as SP_TIME, {fields} from {engine_real.url.database}.{table} '
            f'ON DUPLICATE KEY UPDATE {updates}'
        )
        # logger.bind(step='sql').info(sql)
        conn.execute(text(sql))


def get_day_begin(timestamp=int(time.time())):
    # 将时间戳转换为 datetime 对象
    if timestamp in [None, '', 0]:
        timestamp = int(time.time())
    dt = datetime.datetime.fromtimestamp(timestamp)

    # 获取该日期的0点时间（即00:00:00）
    midnight = dt.replace(hour=0, minute=0, second=0, microsecond=0)

    # 将0点的时间转换回时间戳并返回
    return int(midnight.timestamp())


def load_odps_sql_result(filepath, encoding='utf-8'):
    with open(filepath, encoding=encoding) as fd:
        dfs = []
        data = []
        fields = None
        for line in fd:
            print(line)
            if fields is None and line.startswith('+----'):
                line = fd.readline()
                fields = [i.strip() for i in line.strip('| \n\r').split('|')]
                fd.readline()
            elif fields is not None and line.startswith('|'):
                data.append([i.strip() for i in line.strip('| \n\r').split('|')])
            elif fields is not None and line.startswith('+----'):
                dfs.append(pd.DataFrame(data, columns=fields, dtype=str))
                data = []
                fields = None
        return dfs


def format_complex(z):
    real = z.real
    imag = z.imag
    if imag >= 0:
        return f'{real} + {imag}j'
    else:
        return f'{real} - {-imag}j'


# a/b 结果保留4位小数，如果b=0，返回0
def division_0(a, b):
    if b == 0:
        return 0
    else:
        return round(a / b, 4)


if __name__ == '__main__':
    pass
    # get_table_schema('dms_dms_def_bulk')
    # dfs = load_odps_sql_result('date.txt')
    #
    # for i in dfs:
    #     i.to_csv(f'{len(i)}.csv', index=False)
