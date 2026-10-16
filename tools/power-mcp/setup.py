"""Install the isolated, pinned calculation runtime; never change system Python."""
import argparse
from pathlib import Path
import subprocess
import sys
import venv

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    if sys.version_info[:2] != (3,12):
        raise SystemExit('Use Python 3.12 to install the validated runtime.')
    root=Path(__file__).resolve().parents[2]
    environment=root/'tools/power-mcp-venv'
    python=environment/('Scripts/python.exe' if sys.platform=='win32' else 'bin/python')
    if not args.check:
        if not python.exists():venv.EnvBuilder(with_pip=True).create(environment)
        lock=Path(__file__).with_name('requirements.lock.txt')
        subprocess.run([str(python),'-m','pip','install','-r',str(lock)],check=True)
    subprocess.run([str(python),'-m','pip','check'],check=True)
    subprocess.run([str(python),'-c',"import pandapower,pypsa,andes;from importlib.metadata import version;print({p:version(p) for p in ['powermcp','mcp','pandapower','pypsa','andes','highspy']})"],check=True)

if __name__=='__main__':main()
