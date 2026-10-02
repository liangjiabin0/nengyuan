from __future__ import annotations
from .backends.dry_run import DryRunBackend
from .backends.pandapower_opf import PandapowerACOPFBackend, PandapowerDCOPFBackend
from .backends.custom_pyomo import CustomPyomoBackend

class BackendRegistry:
    def __init__(self):
        self._items={}
        for cls in [DryRunBackend,PandapowerACOPFBackend,PandapowerDCOPFBackend,CustomPyomoBackend]: self.register(cls())
    def register(self, backend): self._items[backend.name]=backend
    def get(self,name):
        if name not in self._items: raise KeyError(f"Unknown backend {name}. Registered: {sorted(self._items)}")
        return self._items[name]
    def list(self):
        return [{"name":k,"capabilities":vars(v.capabilities)} for k,v in self._items.items()]
