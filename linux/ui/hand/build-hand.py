#!/usr/bin/env python3
"""Build the overview hand for Qt Quick 3D.

Inputs (ui/hand/):
  right-hand.glb   the WebXR generic hand (MIT, see README.md and Hand-LICENSE.txt)
  hand.json        upstream's export of it (Sources/Kinesis/Resources): joint rest transforms in the
                   app's hand space, and each joint's parent

Outputs:
  ui/hand/hand.mesh    the skinned mesh, converted by Qt's balsam
  ui/qml/handdata.js   the rig and the framing

The model stores its 25 joints flat. Like upstream, the rig rebuilds the finger chains from
hand.json's parents, so bending a knuckle carries the rest of the finger. The mesh keeps balsam's
inverse bind poses: with every joint at hand.json's rest pose (the glTF pose mapped into the app's
hand space), skinning lands the mesh in that same space, where upstream's poses and framing are
defined. Upstream measures the framing from the relaxed hand at runtime; it is computed here.

Needs numpy, balsam (qt6-quick3d-dev-tools) and its importer (qt6-quick3d-assetimporters-plugin)
to build; the app only needs the outputs.

usage: ui/hand/build-hand.py
"""

import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
QML = HERE.parent / "qml"
BALSAM = shutil.which("balsam") or "/usr/lib/qt6/bin/balsam"

# Upstream's relaxed pose (HandRig.swift), which the framing is measured against.
RELAXED_CURLS = {"index": (18, 24, 12), "middle": (22, 28, 14), "ring": (26, 32, 16), "pinky": (30, 34, 18)}
RELAXED_THUMB = {"base": (0, 0, 0), "middle": 8, "end": 10}
# Where thumb and index meet in a pinch, in hand space: the dial turns the hand around it.
PINCH_POINT = (-0.434, 1.917, -1.257)


def axis_angle(axis, degrees):
    """Rotation matrix (4x4) about a unit axis."""
    x, y, z = axis
    a = math.radians(degrees)
    c, s, t = math.cos(a), math.sin(a), 1 - math.cos(a)
    m = np.eye(4)
    m[:3, :3] = [[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
                 [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
                 [t * x * z - s * y, t * y * z + s * x, t * z * z + c]]
    return m


def joint_turn(degrees):
    """Upstream's joint rotation: about x, then y, then z, in the joint's own frame."""
    x, y, z = degrees
    return axis_angle((1, 0, 0), x) @ axis_angle((0, 1, 0), y) @ axis_angle((0, 0, 1), z)


def to_quaternion(m):
    """(w, x, y, z) of the rotation in an orthonormal 3x3."""
    r = m[:3, :3]
    trace = r[0, 0] + r[1, 1] + r[2, 2]
    if trace > 0:
        s = math.sqrt(trace + 1) * 2
        return [s / 4, (r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s]
    i = int(np.argmax([r[0, 0], r[1, 1], r[2, 2]]))
    j, k = (i + 1) % 3, (i + 2) % 3
    s = math.sqrt(1 + r[i, i] - r[j, j] - r[k, k]) * 2
    q = [0.0, 0.0, 0.0, 0.0]
    q[0] = (r[k, j] - r[j, k]) / s
    q[1 + i] = s / 4
    q[1 + j] = (r[j, i] + r[i, j]) / s
    q[1 + k] = (r[k, i] + r[i, k]) / s
    return q


def split(m):
    """Translation, rotation (w, x, y, z), and per-axis scale of an affine transform."""
    scale = np.linalg.norm(m[:3, :3], axis=0)
    unscaled = m.copy()
    unscaled[:3, :3] = m[:3, :3] / scale
    return m[:3, 3].tolist(), to_quaternion(unscaled), scale.tolist()


def convert_mesh(tmp: Path) -> str:
    """Run balsam on the glTF; keep its mesh, and return the generated QML for the bind poses."""
    result = subprocess.run([BALSAM, "-o", str(tmp), str(HERE / "right-hand.glb")], capture_output=True, text=True)
    meshes = list((tmp / "meshes").glob("*.mesh")) if (tmp / "meshes").is_dir() else []
    generated = list(tmp.glob("*.qml"))
    if result.returncode != 0 or len(meshes) != 1 or len(generated) != 1:
        sys.exit(f"balsam didn't produce one mesh and one QML file:\n{result.stdout}{result.stderr}")
    shutil.copyfile(meshes[0], HERE / "hand.mesh")
    return generated[0].read_text()


def main() -> int:
    hand = json.loads((HERE / "hand.json").read_text())
    joints = hand["joints"]
    names = [j["name"] for j in joints]
    parents = [j["parent"] for j in joints]
    if any(p >= i for i, p in enumerate(parents)):
        sys.exit("hand.json lists a joint before its parent")
    rest_world = [np.array(j["rest"], dtype=float).reshape(4, 4).T for j in joints]  # stored column-major
    rest_local = [rest_world[i] if p < 0 else np.linalg.inv(rest_world[p]) @ rest_world[i] for i, p in enumerate(parents)]

    with tempfile.TemporaryDirectory() as tmp:
        generated = convert_mesh(Path(tmp))
    skin_joints = [s.strip() for s in re.search(r"joints: \[(.*?)\]", generated, re.S).group(1).split(",") if s.strip()]
    if [s.replace("_", "-") for s in skin_joints] != names:
        sys.exit("balsam's skin joints aren't in hand.json's order")
    bind_poses = [[float(v) for v in args.split(",")] for args in re.findall(r"Qt\.matrix4x4\(([^)]*)\)", generated)]
    if len(bind_poses) != len(names) or any(len(m) != 16 for m in bind_poses):
        sys.exit("balsam's inverse bind poses don't match the joints")

    # The shader lights fingertips and fades the wrist by where each vertex sits at rest, as upstream
    # bakes them: every joint's rest pose times its inverse bind pose is the same mesh-to-hand map.
    to_hand = [rest_world[i] @ np.array(m).reshape(4, 4) for i, m in enumerate(bind_poses)]
    if max(np.abs(m - to_hand[0]).max() for m in to_hand) > 1e-3:
        sys.exit("balsam's bind poses don't match hand.json's rest pose")

    # Framing: the relaxed hand, seen the way upstream's Coordinator.facing shows it, fitted to its
    # visible skin (the wrist fades out, so only vertices past y = 0.1 count).
    posed_local = list(rest_local)
    def pose(name, degrees):
        i = names.index(name)
        posed_local[i] = rest_local[i] @ joint_turn(degrees)
    for finger, curl in RELAXED_CURLS.items():
        for part, angle in zip(("phalanx-proximal", "phalanx-intermediate", "phalanx-distal"), curl):
            pose(f"{finger}-finger-{part}", (-angle, 0, 0))
    pose("thumb-metacarpal", RELAXED_THUMB["base"])
    pose("thumb-phalanx-proximal", (-RELAXED_THUMB["middle"], 0, 0))
    pose("thumb-phalanx-distal", (-RELAXED_THUMB["end"], 0, 0))
    posed_world = []
    for i, p in enumerate(parents):
        posed_world.append(posed_local[i] if p < 0 else posed_world[p] @ posed_local[i])
    deform = np.array([posed_world[i] @ np.linalg.inv(rest_world[i]) for i in range(len(names))])
    positions = np.array(hand["positions"], dtype=float).reshape(-1, 3)
    bones = np.array(hand["boneIndices"]).reshape(-1, 4)
    weights = np.array(hand["boneWeights"], dtype=float).reshape(-1, 4)
    points = np.c_[positions, np.ones(len(positions))]
    relaxed = np.einsum("vk,vkab,vb->va", weights, deform[bones], points)
    side = np.eye(4)
    side[:3, :3] = np.array([[0, 0, -1], [-1, 0, 0], [0, 1, 0]], dtype=float).T  # upstream's columns
    facing = axis_angle((0, 0, 1), -34) @ axis_angle((1, 0, 0), 24) @ axis_angle((0, 1, 0), -28) @ side
    seen = (facing @ relaxed[positions[:, 1] > 0.1].T).T[:, :2]
    low, high = seen.min(axis=0), seen.max(axis=0)
    centre = (low + high) / 2
    reach = float(max(high - low))
    view = np.eye(4)
    view[:2, 3] = -centre
    view = view @ facing
    pivot = (view @ np.array([*PINCH_POINT, 1.0]))[:3]
    forearm = view[:3, :3] @ np.array([0.0, 1.0, 0.0])
    forearm /= np.linalg.norm(forearm)

    rest = []
    for m in rest_local:
        position, rotation, scale = split(m)
        rest.append({"position": position, "rotation": rotation, "scale": scale})
    view_position, view_rotation, _ = split(view)
    round6 = lambda value: json.loads(json.dumps(value), parse_float=lambda text: round(float(text), 6))
    data = {
        "names": names, "parents": parents, "rest": round6(rest), "inverseBindPoses": bind_poses,
        "view": round6({"position": view_position, "rotation": view_rotation}),
        # Half the view's height in hand units, before upstream's 0.72 (overview) / 0.7 (teaching) margin.
        "reach": round(reach / 2, 6), "pivot": round6(pivot.tolist()), "forearm": round6(forearm.tolist()),
        "meshToHand": round6(to_hand[0].flatten().tolist()), "restTips": hand["tips"],
    }
    lines = ["// Generated by ui/hand/build-hand.py from hand.json and right-hand.glb. Don't edit.", ".pragma library", ""]
    lines += [f"var {key} = {json.dumps(value, separators=(',', ':'))};" for key, value in data.items()]
    (QML / "handdata.js").write_text("\n".join(lines) + "\n")
    print(f"hand.mesh and handdata.js: {len(names)} joints, reach {reach:.3f}, pivot {np.round(pivot, 3).tolist()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
