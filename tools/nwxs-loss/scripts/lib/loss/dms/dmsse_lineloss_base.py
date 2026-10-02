import os
import sys
import time
import signal
from datetime import datetime, timedelta

# 设置路径
CUR_PATH = os.path.abspath(os.path.dirname(__file__))
lib_dir = os.path.dirname(os.path.dirname(CUR_PATH))
if lib_dir not in sys.path:
    sys.path.insert(0, lib_dir)

from lib.dms.common.grid_model_builder import ModelBuilder
from lib.dms.dms_model import DMSModelBase
from lib.helper.log import logger

time_step = 1e3

tie_time = time.time()


def convert_loss_result_to_dms_common_table(time_index, feeder_id, loss_result):
    """将计算结果转化为内部定义的配网线损通用表"""
    #  需要单独处理的表

    loss_result['statics']['time_index'] = str(time_index)
    loss_result['statics']['feeder_id'] = str(feeder_id)
    return loss_result


def process_one_feeder(feeder_model, day_time, time_index, cons_para, method_type='04', dms_tables=None, **keywords):
    def handle_sigterm(signum, frame):
        print(f'子进程 {os.getpid()} 收到 SIGTERM 信号，正在退出...')
        exit(0)

    # 为子进程安装 SIGTERM 信号处理器
    signal.signal(signal.SIGTERM, handle_sigterm)
    signal.signal(signal.SIGINT, handle_sigterm)

    try:
        _t = time.perf_counter()

        # datatime = f'{day_time[:4]}-{day_time[4:6]}-{day_time[6:]} {int(time_index):02d}:00:00'

        ###1.设置基准时间
        base_date = datetime.strptime(day_time, '%Y%m%d')

        ###2.根据分辨率因子计算时间偏移
        if abs(cons_para.time_resolution_factor - 0.25) < 1e-6:  # 15分钟分辨率
            delta = timedelta(minutes=15 * time_index)
        elif abs(cons_para.time_resolution_factor - 1.0) < 1e-6:  # 1小时分辨率
            delta = timedelta(hours=time_index)
        elif abs(cons_para.time_resolution_factor - 1 / 60) < 1e-6:  # 1分钟分辨率
            delta = timedelta(minutes=time_index)
        else:  # 其他分辨率通用处理
            delta = timedelta(minutes=round(time_index * cons_para.time_resolution_factor * 60))

        ###3.生成最终时间
        datatime = (base_date + delta).strftime('%Y-%m-%d %H:%M:%S')

        model_builder = ModelBuilder(feeder_model, cons_para)

        # Loss
        from dms.common.calculator import Loss

        loss = Loss(model_builder)
        if feeder_model:
            feeder_id = feeder_model['FEEDER_ID']
            feeder_name = feeder_model['FEEDER_NAME']
            feeder_rdfid = feeder_model['RDF_ID']
            company_rdfid = feeder_model['AREA_RDFID']
            company_name = feeder_model['AREA_NAME']
        else:
            feeder = keywords.get('feeder', {})
            feeder_id = feeder['ID']
            feeder_name = feeder['NAME']
            feeder_rdfid = feeder['RDF_ID']
            company_rdfid = feeder['AREA_RDFID']
            company_name = feeder['AREA_NAME']

        loss.build_and_check_model()
        if loss.model_error:
            return loss.get_error_result(feeder_id, feeder_name, feeder_rdfid, time_index, datatime)

        loss.calculate()

        if loss.calc_error:
            return loss.get_error_result(feeder_id, feeder_name, feeder_rdfid, time_index, datatime)

        res = (
            loss.calc_loss_result_static_dms(time_index, datatime, method_type, company_rdfid, company_name)
            if method_type == '04'
            else loss.calc_loss_result_static_ier(time_index, datatime, dms_tables)
        )

        print(f'{feeder_model["FEEDER_NAME"]}馈线成功计算')
        print('*********************************************')
        logger.info(f'{feeder_model["FEEDER_NAME"]} 计算耗时：{time.perf_counter() - _t:.2f}s')
        return res

    except Exception:
        logger.exception('子进程异常')
        print(f'子进程 {os.getpid()} 被手动中断')
        exit(0)


def start_calc_one_feeder(
    day_time,
    time_index,
    feeder_index,
    cons_para,
    dms_tables,
    dms_model: DMSModelBase,
    method_type='04',
):
    logger.bind(step='start_calc_one_feeder').info(f'time_index:{time_index} feeder_index:{feeder_index}')

    # 处理cons_para导入
    if isinstance(cons_para, str):
        # 添加skill根目录到sys.path
        import importlib
        skill_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(CUR_PATH))))
        if skill_root not in sys.path:
            sys.path.insert(0, skill_root)
        try:
            cons_para = importlib.import_module(cons_para)
        except ImportError:
            logger.warning(f'Failed to import {cons_para}, using default parameters')
            # 使用默认参数
            from lib.dms import dms_cons_para
            cons_para = dms_cons_para

    if dms_model.feeders:
        feeder_id = list(dms_model.feeders.keys())[0]
        feeder_model = dms_model.get_feeder_model(feeder_id) or {}
        if not feeder_model:
            logger.bind(step='start_calc_one_feeder').info(f'feeders:{dms_model.feeders}')
            raise ValueError('feeder_model is empty!')
        feeder_model['bvs'] = dms_model.bvs
        if method_type == '04':
            result = process_one_feeder(feeder_model, day_time, time_index, cons_para, method_type=method_type)
        else:
            result = process_one_feeder(
                feeder_model,
                day_time,
                time_index,
                cons_para,
                method_type=method_type,
                dms_tables=dms_tables,
            )
        return convert_loss_result_to_dms_common_table(time_index, feeder_id, result)
    else:
        logger.bind(step='start_calc_one_feeder').info('dms_model读取的馈线数据为空！')
        return {
            'statics': {'bug_feeder': True, 'time_index': time_index, 'feeder_id': None},
        }


if __name__ == '__main__':
    pass
    # parser = argparse.ArgumentParser(description="三相理论线损计算程序")
    #
    # # parser.add_argument('--feeder', '-f', type=str, default='3378262670481293313', help='要计算的馈线ID', required=False)
    # parser.add_argument('--feeder', '-f', type=str, default=None, help='要计算的馈线ID', required=False)
    # parser.add_argument('--time', '-t', type=str, default=None, help='要计算的时间', required=False)
    # parser.add_argument('--loop', '-l', type=bool, default=False, help='是否循环计算', required=False)
    # parser.add_argument('--refresh', '-r', type=bool, default=False, help='是否每次读取新数据', required=False)
    # parser.add_argument('--count', '-n', type=int, default=-1, help='计算前多少条馈线', required=False)
    # parser.add_argument('--day', '-d', type=int, default=None, help='日期0点', required=False)
    # parser.add_argument('--index', '-i', type=int, default=0, help='时间序号', required=False)
    # parser.add_argument('--his', '-s', type=bool, default=True, help='立刻同步到HIS', required=False)
    #
    # # dms_model = DMSModel()
    # # dms_model.real_model()
    # dms_model = None
    #
    # args = parser.parse_args()
    # while args.loop:
    #     FEEDERLOSS = start_calc(dms_model, args.feeder, args.time, args.refresh, args.count, args.day, args.index,
    #                             args.his)
    #
    # FEEDERLOSS = start_calc(dms_model, args.feeder, args.time, args.refresh, args.count, args.day, args.index, args.his)
