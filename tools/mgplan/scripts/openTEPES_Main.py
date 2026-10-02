import argparse
import os
import uuid, sys
from typing import Any, cast
from openTEPES import openTEPES_run
from memory_profiler import memory_usage
from matplotlib.pyplot import plot, show
parser = argparse.ArgumentParser(description='Introducing main parameters...')
parser.add_argument('--case',   type=str, default=None)
parser.add_argument('--dir',    type=str, default=None)
parser.add_argument('--solver', type=str, default=None)
parser.add_argument('--log',    type=str, default=None)

DIR    = os.path.dirname(__file__)
# arg = sys.argv[1]
# External RTDB paths are intentionally unsupported; use MGPLAN_CONFIG_DIR.
CASE   = 'sSEP'
SOLVER = 'gurobi'
LOG    = 'Yes'

def check_mac():
    '''This function checks the MAC address of the system and returns True if it is correct'''
    mac_address = uuid.UUID(int=uuid.getnode()).hex[-12:].upper()
    mac_address = '-'.join([mac_address[i:i+2] for i in range(0, 11, 2)])
    print('MAC address of the system is:', mac_address)
    if mac_address != '2C-8D-B1-A2-F3-A4': # 00-0C-29-9A-24-63
        print("MAC address is not correct. Please check the MAC address in the system settings.")
        sys.exit(1)
    else:
        print("MAC address is correct.")

def main():
    print(CASE)
    print(DIR)
    print(SOLVER)
    openTEPES_run(DIR, CASE, SOLVER, LOG)
    print('End of the run                ************')

if __name__ == '__main__':
    # check_mac()
    main()
    # mem_use = memory_usage(cast(Any, (main, ))) # 监控内存使用情况
    # print(mem_use)
    # plot(mem_use) # 绘制内存使用曲线
    # print(f"Maximum memory usage: {max(mem_use)} MiB")
    show()
