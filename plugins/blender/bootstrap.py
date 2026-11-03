"""Ouvre une session Blender connectée, sans changer les préférences enregistrées."""
import importlib.util
from pathlib import Path
import sys

path = Path(__file__).with_name("francestudent_connect.py")
spec = importlib.util.spec_from_file_location("francestudent_connect", str(path))
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.register()
module.start_bridge()
