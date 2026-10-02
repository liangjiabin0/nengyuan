"""Restore non-Git model/case resources from an existing authorized installation.

Usage: python scripts/restore-runtime-assets.py --source /data/ai4es --target /data/new-release
Never copy environments, settings, databases or licenses with this helper.
"""
import argparse,json,shutil,hashlib
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--target',required=True)
args=parser.parse_args();source=Path(args.source).resolve();target=Path(args.target).resolve()
if source==target:raise SystemExit('Source and target must differ')
rules=[('tools/ses-iesp-esopt','case*/sSEP/*'),('tools/pv-wind-load-forecast','**/weights/*'),('tools/esopt/work/DCOPF/build','*'),('tools/ses-iesp-esopt/build','*')]
records=[]
for directory,pattern in rules:
 for original in (source/directory).glob(pattern):
  if not original.is_file():continue
  if original.suffix.lower() not in {'.csv','.json','.yaml','.yml','.hdf5','.h5','.keras','.exe','.dll','.so','.a'}:continue
  if original.name.startswith(('oT_Result_','oT_Plot_','opentepes_Model_Info')):continue
  relative=original.relative_to(source);destination=(target/relative).resolve()
  if not destination.is_relative_to(target):raise ValueError('Destination escaped target')
  destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(original,destination)
  digest=hashlib.sha256(original.read_bytes()).hexdigest()
  records.append({'path':relative.as_posix(),'bytes':original.stat().st_size,'sha256':digest,'platform':'Windows' if original.suffix.lower() in {'.exe','.dll'} else 'data/model/native'})
(target/'storage').mkdir(exist_ok=True)
(target/'storage/runtime-assets-restored.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'restored':len(records),'target':str(target)},ensure_ascii=False))
