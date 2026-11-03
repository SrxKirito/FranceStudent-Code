"""FranceStudent Connect: pont local Blender, exécuté sur le thread principal."""
bl_info = {"name": "FranceStudent Connect", "author": "FranceStudent IDE contributors", "version": (0, 1, 0), "blender": (4, 0, 0), "location": "Vue 3D > N > FranceStudent", "category": "Interface"}

import base64
import bpy
import contextlib
import io
import json
import math
import os
from pathlib import Path
import secrets
import socket
import tempfile
import time

_server = None
_clients = {}
_token = None
_session_path = None
_MAX_REQUEST = 1024 * 1024


def _vector(value, size=3):
    if not isinstance(value, list) or len(value) != size or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value):
        raise ValueError("Vecteur numérique invalide")
    return value


def _object(name):
    if not isinstance(name, str) or not name:
        raise ValueError("Nom d’objet requis")
    obj = bpy.data.objects.get(name)
    if obj is None:
        raise ValueError("Objet introuvable : " + name)
    return obj


def _describe(obj):
    return {"name": obj.name, "type": obj.type, "location": list(obj.location), "rotation": list(obj.rotation_euler), "scale": list(obj.scale), "dimensions": list(obj.dimensions)}


def _execute(action, args):
    if action == "scene_info":
        objects = list(bpy.context.scene.objects)
        return {"blender_version": bpy.app.version_string, "scene": bpy.context.scene.name, "objects": [_describe(obj) for obj in objects[:200]], "total_objects": len(objects), "truncated": len(objects) > 200, "python_enabled": bool(bpy.context.window_manager.francestudent_python_enabled)}
    if action == "object_info":
        return _describe(_object(args.get("name")))
    if action == "create_primitive":
        operations = {"cube": bpy.ops.mesh.primitive_cube_add, "sphere": bpy.ops.mesh.primitive_uv_sphere_add, "cylinder": bpy.ops.mesh.primitive_cylinder_add, "plane": bpy.ops.mesh.primitive_plane_add, "cone": bpy.ops.mesh.primitive_cone_add, "torus": bpy.ops.mesh.primitive_torus_add}
        kind = args.get("kind", "cube")
        if kind not in operations:
            raise ValueError("Primitive inconnue")
        location = _vector(args.get("location", [0, 0, 0]))
        scale = _vector(args.get("scale", [1, 1, 1]))
        name = args.get("name", kind)
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            raise ValueError("Nom invalide")
        operations[kind](location=location)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        return _describe(obj)
    if action == "transform_object":
        obj = _object(args.get("name"))
        changes = {key: _vector(args[key]) for key in ("location", "rotation", "scale") if key in args}
        for key, value in changes.items():
            setattr(obj, "rotation_euler" if key == "rotation" else key, value)
        return _describe(obj)
    if action == "set_material":
        obj = _object(args.get("name"))
        color = _vector(args.get("color"), 4)
        if any(v < 0 or v > 1 for v in color) or not hasattr(obj.data, "materials"):
            raise ValueError("Couleur ou objet incompatible")
        material = bpy.data.materials.new(obj.name + "_FranceStudent")
        material.diffuse_color = color
        material.use_nodes = True
        shader = material.node_tree.nodes.get("Principled BSDF")
        if shader:
            shader.inputs["Base Color"].default_value = color
            shader.inputs["Alpha"].default_value = color[3]
        if len(obj.data.materials):
            obj.data.materials[0] = material
        else:
            obj.data.materials.append(material)
        return {"object": obj.name, "material": material.name, "color": color}
    if action == "delete_objects":
        names = args.get("names")
        if not isinstance(names, list) or not names or len(names) > 100:
            raise ValueError("Liste de 1 à 100 noms requise")
        objects = [_object(name) for name in dict.fromkeys(names)]
        deleted = [obj.name for obj in objects]
        for obj in objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        return {"deleted": deleted}
    if action == "execute_python":
        if not bpy.context.window_manager.francestudent_python_enabled:
            raise PermissionError("Scripts Python désactivés. L’utilisateur peut les autoriser dans le panneau FranceStudent de Blender ; ne pas contourner ce choix.")
        code = args.get("code")
        if not isinstance(code, str) or not code.strip() or len(code) > 100000:
            raise ValueError("Script vide ou trop long")
        output = io.StringIO()
        namespace = {"bpy": bpy, "__name__": "__francestudent__"}
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            exec(compile(code, "<FranceStudent>", "exec"), namespace)
        result = namespace.get("result")
        json.dumps(result, allow_nan=False)
        return {"output": output.getvalue()[-20000:], "result": result}
    if action == "get_screenshot":
        if bpy.app.background:
            raise ValueError("Capture du viewport indisponible sans fenêtre Blender")
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                if area.type != "VIEW_3D":
                    continue
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region is None:
                    continue
                scene = window.scene
                render = scene.render
                previous = (render.filepath, render.image_settings.file_format, render.resolution_x, render.resolution_y, render.resolution_percentage)
                fd, target = tempfile.mkstemp(prefix="francestudent-", suffix=".png")
                os.close(fd)
                try:
                    render.filepath = target
                    render.image_settings.file_format = "PNG"
                    render.resolution_x, render.resolution_y, render.resolution_percentage = 960, 640, 100
                    with bpy.context.temp_override(window=window, area=area, region=region):
                        bpy.ops.render.opengl(write_still=True, view_context=True)
                    data = Path(target).read_bytes()
                    if len(data) > 5 * 1024 * 1024:
                        raise ValueError("Capture trop volumineuse")
                    return {"image": {"mimeType": "image/png", "data": base64.b64encode(data).decode("ascii")}}
                finally:
                    render.filepath, render.image_settings.file_format, render.resolution_x, render.resolution_y, render.resolution_percentage = previous
                    Path(target).unlink(missing_ok=True)
        raise ValueError("Aucune vue 3D ouverte")
    raise ValueError("Action inconnue")


def _reply(client, message):
    payload = (json.dumps(message, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
    if len(payload) > 8 * 1024 * 1024:
        raise ValueError("Réponse trop volumineuse")
    _clients[client] = {"output": payload, "at": time.monotonic()}


def _tick():
    if _server is None:
        return None
    deadline = time.monotonic() + 0.02
    try:
        while len(_clients) < 8 and time.monotonic() < deadline:
            try:
                client, _address = _server.accept()
            except BlockingIOError:
                break
            client.setblocking(False)
            _clients[client] = {"input": b"", "at": time.monotonic()}
        for client, entry in list(_clients.items()):
            if time.monotonic() > deadline:
                break
            try:
                if time.monotonic() - entry["at"] > 30:
                    raise TimeoutError("Connexion expirée")
                if "output" in entry:
                    sent = client.send(entry["output"])
                    entry["output"] = entry["output"][sent:]
                    if not entry["output"]:
                        client.close()
                        del _clients[client]
                    continue
                data = client.recv(65536)
                if not data:
                    raise ConnectionError("Connexion fermée")
                entry["input"] += data
                if len(entry["input"]) > _MAX_REQUEST:
                    raise ValueError("Requête trop grande")
                if b"\n" not in entry["input"]:
                    continue
                request = json.loads(entry["input"].split(b"\n", 1)[0])
                if not secrets.compare_digest(str(request.get("token", "")), _token):
                    raise PermissionError("Connexion non autorisée")
                args = request.get("arguments", {})
                if not isinstance(args, dict):
                    raise ValueError("Arguments invalides")
                try:
                    result = _execute(request.get("action"), args)
                    _reply(client, {"success": True, "result": result})
                except Exception as error:
                    _reply(client, {"success": False, "error": str(error)[:3000], "effects_may_have_occurred": request.get("action") in {"create_primitive", "transform_object", "set_material", "delete_objects", "execute_python"}})
            except BlockingIOError:
                pass
            except Exception:
                client.close()
                _clients.pop(client, None)
    except Exception:
        stop_bridge()
        return None
    return 0.05


def start_bridge():
    global _server, _token, _session_path
    if _server is not None:
        return
    configured = os.environ.get("FRANCESTUDENT_BLENDER_SESSION_FILE") or bpy.context.window_manager.francestudent_session_file
    if not configured:
        raise ValueError("Choisis le fichier de connexion indiqué par l’IDE")
    _session_path = Path(configured).expanduser().resolve()
    _session_path.parent.mkdir(parents=True, exist_ok=True)
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        server.bind(("127.0.0.1", 0))
        server.listen(8)
        server.setblocking(False)
        token = secrets.token_hex(32)
        temp = _session_path.with_suffix(".tmp")
        temp.write_text(json.dumps({"host": "127.0.0.1", "port": server.getsockname()[1], "token": token, "pid": os.getpid()}), encoding="utf-8")
        os.chmod(temp, 0o600)
        temp.replace(_session_path)
        _server, _token = server, token
        if not bpy.app.timers.is_registered(_tick):
            bpy.app.timers.register(_tick, first_interval=0.1, persistent=True)
    except Exception:
        server.close()
        raise


def stop_bridge():
    global _server, _token
    for client in list(_clients):
        client.close()
    _clients.clear()
    if _server:
        _server.close()
    if _session_path and _session_path.exists():
        try:
            if json.loads(_session_path.read_text(encoding="utf-8")).get("token") == _token:
                _session_path.unlink()
        except (ValueError, OSError):
            pass
    _server, _token = None, None


class FRANCESTUDENT_OT_connect(bpy.types.Operator):
    bl_idname = "francestudent.connect"
    bl_label = "Connecter à l’IDE"
    def execute(self, context):
        try:
            start_bridge()
            return {"FINISHED"}
        except Exception as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}


class FRANCESTUDENT_OT_disconnect(bpy.types.Operator):
    bl_idname = "francestudent.disconnect"
    bl_label = "Déconnecter"
    def execute(self, context):
        stop_bridge()
        return {"FINISHED"}


class FRANCESTUDENT_PT_connect(bpy.types.Panel):
    bl_label = "FranceStudent Connect"
    bl_idname = "FRANCESTUDENT_PT_connect"
    bl_space_type, bl_region_type, bl_category = "VIEW_3D", "UI", "FranceStudent"
    def draw(self, context):
        layout = self.layout
        layout.label(text="Connecté en local" if _server else "Non connecté")
        layout.prop(context.window_manager, "francestudent_session_file", text="Fichier IDE")
        layout.prop(context.window_manager, "francestudent_python_enabled", text="Autoriser les scripts Python")
        layout.operator("francestudent.disconnect" if _server else "francestudent.connect")


_CLASSES = (FRANCESTUDENT_OT_connect, FRANCESTUDENT_OT_disconnect, FRANCESTUDENT_PT_connect)


def register():
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.WindowManager.francestudent_session_file = bpy.props.StringProperty(subtype="FILE_PATH", default=os.environ.get("FRANCESTUDENT_BLENDER_SESSION_FILE", ""))
    bpy.types.WindowManager.francestudent_python_enabled = bpy.props.BoolProperty(default=False)


def unregister():
    stop_bridge()
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)
    del bpy.types.WindowManager.francestudent_session_file
    del bpy.types.WindowManager.francestudent_python_enabled
