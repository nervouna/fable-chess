# Builds the authored unit models and exports them for the game.
#
#   blender -b -P tools/blender/build.py -- <out_dir> [--preview <dir>] [names...]
#
# For each unit this writes <out_dir>/<name>.glb and <name>_ao.png (R = ambient occlusion,
# G = edge wear, B = mud). Coordinates are in the game's space (x right, y up, z forward) and in
# each unit's local, unscaled frame; T() converts to Blender's. Joint names and pivots mirror the
# procedural rigs in src/units.ts so the existing choreography drives these models unchanged.
# A mesh named "Part__bone" travels with that bone in the game (so it can be thrown as debris).
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector, Matrix, Euler

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else 'public/models')
PREVIEW = os.path.abspath(argv[argv.index('--preview') + 1]) if '--preview' in argv else None
ONLY = [a for i, a in enumerate(argv[1:], 1) if not a.startswith('--') and argv[i - 1] != '--preview']
os.makedirs(OUT, exist_ok=True)
T = lambda p: Vector((p[0], -p[2], p[1]))  # game (x, y, z) -> Blender (x, -z, y)
PI = math.pi

# ---------- materials (names are the contract with the game; colours here are the red side) ----------
PALETTE = {
    'coat': ((0.26, 0.10, 0.04), 0.75, 0.0), 'mane': ((0.03, 0.015, 0.01), 0.9, 0.0), 'black': ((0.01, 0.01, 0.01), 0.6, 0.0),
    'cloth': ((0.45, 0.02, 0.015), 0.75, 0.0), 'clothDark': ((0.11, 0.005, 0.004), 0.85, 0.0), 'armor': ((0.27, 0.012, 0.008), 0.45, 0.35),
    'trim': ((0.76, 0.43, 0.07), 0.32, 0.95), 'iron': ((0.4, 0.45, 0.5), 0.28, 1.0), 'leather': ((0.045, 0.02, 0.01), 0.9, 0.0),
    'skin': ((0.72, 0.42, 0.24), 0.8, 0.0), 'wood': ((0.14, 0.065, 0.023), 0.85, 0.0), 'darkWood': ((0.047, 0.023, 0.01), 0.9, 0.0),
    'glow': ((1.0, 0.35, 0.03), 0.4, 0.0), 'bronze': ((0.48, 0.25, 0.06), 0.4, 0.95), 'hide': ((0.26, 0.23, 0.19), 0.92, 0.0), 'ivory': ((0.9, 0.82, 0.68), 0.4, 0.0),
}
def mat(name):
    m = bpy.data.materials.get(name)
    if m: return m
    col, rough, metal = PALETTE[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*col, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if name == 'glow': b.inputs['Emission Color'].default_value = (*col, 1); b.inputs['Emission Strength'].default_value = 2.4
    return m

# ---------- per-model state ----------
PARTS, BONES, CUR = [], {}, ['Body', None]   # (object, part key) | name -> (parent, pivot) | part being built
def begin():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    PARTS.clear(); BONES.clear(); part('Body')
def part(name, bone=None): CUR[0], CUR[1] = name, bone   # later meshes join the mesh "name", which rides on `bone`
def bone(name, parent, pivot): BONES[name] = (parent, Vector(pivot))
scene = lambda: bpy.context.scene

# ---------- mesh helpers ----------
def finish(ob, smooth=True, sharp=None):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    old = ob.data; ob.modifiers.clear(); ob.data = me; bpy.data.meshes.remove(old)
    for p in me.polygons: p.use_smooth = smooth
    if sharp is not None: me.set_sharp_from_angle(angle=sharp)
    return ob

def obj(me, material, tmp=False):
    ob = bpy.data.objects.new(me.name, me); scene().collection.objects.link(ob)
    me.materials.append(mat(material)); PARTS.append((ob, '_tmp' if tmp else (CUR[0], CUR[1])))
    return ob

def rigid(ob, name):
    ob.vertex_groups.new(name=name).add(range(len(ob.data.vertices)), 1.0, 'REPLACE')
    return ob

def P(material, kind, loc=(0, 0, 0), scale=(1, 1, 1), rot=(0, 0, 0), to=None, tmp=False, bevel=0.0, subsurf=0, seg=12, sharp=0.6, **kw):
    """Primitive in game space. kind: box | sphere | cone (r1 bottom, r2 top, depth) | torus (R, r). `to` = bone it is rigid to."""
    bm = bmesh.new()
    if kind == 'box': bmesh.ops.create_cube(bm, size=1)
    elif kind == 'sphere': bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=max(6, seg // 2), radius=0.5)
    elif kind == 'cone': bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=kw.get('r1', 0.5), radius2=kw.get('r2', 0.0), depth=kw.get('depth', 1))
    elif kind == 'torus':
        R, r, n, m = kw['R'], kw['r'], seg, 6
        vs = [[bm.verts.new(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b))) for b in [j / m * math.tau for j in range(m)]] for a in [i / n * math.tau for i in range(n)]]
        for i in range(n):
            for j in range(m): bm.faces.new((vs[i][j], vs[(i + 1) % n][j], vs[(i + 1) % n][(j + 1) % m], vs[i][(j + 1) % m]))
    M = Matrix.Translation(Vector(loc)) @ Euler(rot, 'XYZ').to_matrix().to_4x4() @ Matrix.Diagonal((*scale, 1))
    for v in bm.verts: v.co = T(M @ Vector((v.co.x, v.co.z, -v.co.y)))  # the primitive's up axis becomes game y
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(kind); bm.to_mesh(me); bm.free()
    ob = obj(me, material, tmp)
    if bevel: b = ob.modifiers.new('bevel', 'BEVEL'); b.width = bevel; b.segments = 2; b.limit_method = 'ANGLE'
    if subsurf: ob.modifiers.new('sub', 'SUBSURF').levels = subsurf
    finish(ob, sharp=None if subsurf else sharp)
    return rigid(ob, to) if to else ob

def S(material, fn, nu, nv, thick=0.02, subsurf=1, to=None):
    """Curved plate from a parametric surface fn(u, v) -> game position, u and v in 0..1."""
    bm = bmesh.new()
    g = [[bm.verts.new(T(fn(i / nu, j / nv))) for j in range(nv + 1)] for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv): bm.faces.new((g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('sheet'); bm.to_mesh(me); bm.free()
    ob = obj(me, material)
    s = ob.modifiers.new('solid', 'SOLIDIFY'); s.thickness = thick; s.offset = 1
    if subsurf: ob.modifiers.new('sub', 'SUBSURF').levels = subsurf
    finish(ob)
    return rigid(ob, to) if to else ob

def capsule(a, b, ra, rb, sx=1.0):
    """Tapered capsule between two points, as raw material for blob()."""
    a, b = Vector(a), Vector(b); d = b - a
    rot = Vector((0, 1, 0)).rotation_difference(d.normalized()).to_euler('XYZ')
    P('coat', 'cone', loc=(a + b) / 2, rot=rot, scale=(sx, 1, 1), r1=ra, r2=rb, depth=d.length, seg=14, sharp=None, tmp=True)
    P('coat', 'sphere', loc=a, scale=(2 * ra * sx, 2 * ra, 2 * ra), seg=14, tmp=True); P('coat', 'sphere', loc=b, scale=(2 * rb * sx, 2 * rb, 2 * rb), seg=14, tmp=True)
def ball(c, r): P('coat', 'sphere', loc=c, scale=(2 * r[0], 2 * r[1], 2 * r[2]), seg=16, tmp=True)

def blob(material, faces, to=None, voxel=0.016, smooth=12):
    """Fuse every pending capsule and ball into one smooth skin: voxel union, relax, then thin out."""
    obs = [o for o, g in PARTS if g == '_tmp']
    PARTS[:] = [(o, g) for o, g in PARTS if g != '_tmp']
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]; bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.data.materials.clear(); ob.data.materials.append(mat(material)); PARTS.append((ob, (CUR[0], CUR[1])))
    r = ob.modifiers.new('remesh', 'REMESH'); r.mode = 'VOXEL'; r.voxel_size = voxel
    sm = ob.modifiers.new('smooth', 'SMOOTH'); sm.factor = 0.9; sm.iterations = smooth
    finish(ob)
    d = ob.modifiers.new('dec', 'DECIMATE'); d.ratio = min(1.0, faces / max(1, sum(len(p.vertices) - 2 for p in ob.data.polygons)))
    finish(ob)
    return rigid(ob, to) if to else ob

def seg_dist(p, a, b):
    ab = b - a; t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (p - (a + ab * t)).length
def soft(ob, segs, sigma):
    """Smooth weights from distance to each candidate bone's capsule (a, b, radius), top 3 per vertex."""
    groups = {n: ob.vertex_groups.new(name=n) for n in segs}
    caps = {n: (T(a), T(b), r) for n, (a, b, r) in segs.items()}
    for v in ob.data.vertices:
        w = sorted(((math.exp(-(max(0.0, seg_dist(v.co, a, b) - r) / sigma) ** 2), n) for n, (a, b, r) in caps.items()), reverse=True)[:3]
        tot = sum(x for x, _ in w) or 1.0
        for x, n in w:
            if x / tot > 0.01: groups[n].add([v.index], x / tot, 'REPLACE')
    return ob

# ---------- shared pieces ----------
def polearm(kind, o, s, length):
    """Weapon held at `o` (the weapon bone): shaft from 0.6 below the hand, head by kind. Rigid to 'weapon'."""
    A = lambda x, y, z: (o[0] + x * s, o[1] + y * s, o[2] + z * s)
    top = length - 0.6
    P('darkWood', 'cone', A(0, length / 2 - 0.6, 0), r1=0.021 * s, r2=0.021 * s, depth=length * s, seg=8, to='weapon')
    P('iron', 'cone', A(0, -0.64, 0), rot=(PI, 0, 0), r1=0.024 * s, depth=0.08 * s, seg=6, to='weapon')
    P('trim', 'cone', A(0, top - 0.02, 0), r1=0.036 * s, r2=0.03 * s, depth=0.07 * s, seg=10, bevel=0.005, to='weapon')
    if kind == 'spear':
        P('iron', 'sphere', A(0, top + 0.17, 0), scale=(0.1 * s, 0.36 * s, 0.035 * s), seg=10, to='weapon')
        P('cloth', 'cone', A(0, top - 0.1, 0), rot=(PI, 0, 0), r1=0.06 * s, depth=0.15 * s, seg=8, to='weapon')
    elif kind == 'halberd':
        P('iron', 'sphere', A(0, top + 0.2, 0), scale=(0.08 * s, 0.4 * s, 0.03 * s), seg=10, to='weapon')
        S('iron', lambda u, v: A(0.006, top - 0.2 + 0.26 * u + 0.05 * math.sin(PI * u) * v, 0.03 + (0.1 + 0.11 * math.sin(PI * u)) * v), 8, 2, 0.012 * s, 1, to='weapon')  # crescent axe
        P('iron', 'cone', A(0, top - 0.07, -0.07), rot=(-PI / 2, 0, 0), scale=(0.35, 1, 1), r1=0.03 * s, depth=0.12 * s, seg=6, to='weapon')
        P('glow', 'cone', A(0, top - 0.32, 0), rot=(PI, 0, 0), r1=0.07 * s, depth=0.2 * s, seg=8, to='weapon')
    elif kind == 'glaive':
        S('iron', lambda u, v: A(0.006, top + 0.02 + u * 0.62, -0.03 + 0.12 * u * u + (v - 0.25) * 0.19 * math.sin(PI * min(1.0, u * 1.15)) ** 0.6 * (1 - 0.35 * u)), 10, 2, 0.012 * s, 1, to='weapon')
        P('iron', 'cone', A(0, top + 0.2, -0.1), rot=(-1.9, 0, 0), scale=(0.3, 1, 1), r1=0.035 * s, depth=0.13 * s, seg=6, to='weapon')
        P('glow', 'cone', A(0, top - 0.13, 0), rot=(PI, 0, 0), r1=0.055 * s, depth=0.16 * s, seg=8, to='weapon')
    elif kind == 'ge':   # dagger-axe: spike and a blade set at right angles
        P('bronze', 'sphere', A(0, top + 0.14, 0), scale=(0.07 * s, 0.3 * s, 0.03 * s), seg=10, to='weapon')
        P('bronze', 'sphere', A(0, top - 0.04, 0.17), scale=(0.03 * s, 0.09 * s, 0.4 * s), seg=10, to='weapon')
        P('cloth', 'cone', A(0, top - 0.14, 0), rot=(PI, 0, 0), r1=0.05 * s, depth=0.13 * s, seg=8, to='weapon')

HUMAN = ('g', 'torso', 'head', 'armL', 'armR', 'legL', 'legR')
def human(o, s, style, parent=None, prefix='', root='g', pads=True, robe=False):
    """A soldier standing at `o`, scaled by `s`. Limbs are single joints, so every piece is rigid to its bone."""
    A = lambda x, y, z: (o[0] + x * s, o[1] + y * s, o[2] + z * s)
    n = {k: prefix + k for k in HUMAN}; n['g'] = root
    bone(n['g'], parent, o)
    bone(n['legL'], n['g'], A(-0.11, 0.62, 0)); bone(n['legR'], n['g'], A(0.11, 0.62, 0)); bone(n['torso'], n['g'], A(0, 0.62, 0))
    bone(n['head'], n['torso'], A(0, 1.18, 0)); bone(n['armL'], n['torso'], A(-0.29, 1.08, 0)); bone(n['armR'], n['torso'], A(0.29, 1.08, 0))
    bone('weapon', n['armR'], A(0.29, 0.63, 0))
    gen = style == 'general'
    for sx, k in ((-1, 'legL'), (1, 'legR')):
        capsule(A(sx * 0.11, 0.6, 0), A(sx * 0.11, 0.2, 0), 0.085 * s, 0.065 * s); blob('clothDark', 200, to=n[k])
        P('leather', 'box', A(sx * 0.11, 0.075, 0.035), (0.165 * s, 0.15 * s, 0.27 * s), bevel=0.03 * s, subsurf=1, to=n[k])
        P('leather', 'cone', A(sx * 0.11, 0.21, 0), r1=0.074 * s, r2=0.082 * s, depth=0.14 * s, seg=10, to=n[k])
        capsule(A(sx * 0.29, 1.05, 0), A(sx * 0.295, 0.72, 0), 0.07 * s, 0.052 * s); blob('cloth', 180, to=n['arm' + ('L' if sx < 0 else 'R')])
        a = n['arm' + ('L' if sx < 0 else 'R')]
        P('skin', 'sphere', A(sx * 0.295, 0.63, 0), scale=(0.125 * s, 0.14 * s, 0.125 * s), seg=8, to=a)
        P('armor', 'cone', A(sx * 0.295, 0.75, 0), r1=0.058 * s, r2=0.068 * s, depth=0.16 * s, seg=10, bevel=0.008 * s, to=a)
        if pads:
            P('trim' if gen else 'armor', 'sphere', A(sx * 0.31, 1.1, 0), scale=((0.34 if gen else 0.27) * s, 0.19 * s, 0.3 * s), rot=(0, 0, -sx * 0.4), seg=12, to=a)
            P('glow' if gen else 'trim', 'sphere', A(sx * (0.42 if gen else 0.38), 1.13, 0), scale=(0.06 * s, 0.07 * s, 0.07 * s), seg=8, to=a)
        P('black', 'sphere', A(sx * 0.055, 1.345, 0.14), scale=(0.028 * s, 0.04 * s, 0.025 * s), seg=6, to=n['head'])
    ball(A(0, 0.72, 0), (0.19 * s, 0.14 * s, 0.13 * s)); ball(A(0, 0.97, 0), (0.2 * s, 0.2 * s, 0.125 * s)); capsule(A(0, 1.1, 0), A(0, 1.2, 0), 0.065 * s, 0.055 * s)
    blob('clothDark', 320, to=n['torso'])
    for k in range(5):   # lamellar cuirass
        y = 0.7 + k * 0.085; w = (0.218 - abs(k - 2.2) * 0.012) * s
        P('armor', 'cone', A(0, y, 0), scale=(1, 1, 0.66), r1=w + 0.014 * s, r2=w, depth=0.095 * s, seg=16, bevel=0.01 * s, to=n['torso'])
    P('trim', 'cone', A(0, 0.645, 0), scale=(1, 1, 0.68), r1=0.228 * s, r2=0.228 * s, depth=0.06 * s, seg=16, bevel=0.01 * s, to=n['torso'])
    P('trim', 'sphere', A(0, 0.93, 0.14), scale=((0.2 if gen else 0.13) * s, (0.2 if gen else 0.13) * s, 0.05 * s), seg=10, to=n['torso'])
    P('cloth', 'cone', A(0, 1.12, 0), r1=0.12 * s, r2=0.085 * s, depth=0.08 * s, seg=12, to=n['torso'])
    if robe: P('cloth', 'cone', A(0, 0.36, 0), scale=(1, 1, 0.8), r1=0.42 * s, r2=0.25 * s, depth=0.6 * s, seg=16, bevel=0.01 * s, to=n['torso'])
    else: P('cloth', 'cone', A(0, 0.5, 0), scale=(1, 1, 0.78), r1=0.33 * s, r2=0.24 * s, depth=0.3 * s, seg=16, bevel=0.01 * s, to=n['torso'])
    if gen:   # tassets over the hips and a broad gilt hem
        for sx in (-1, 1): P('armor', 'box', A(sx * 0.17, 0.44, 0.03), (0.2 * s, 0.34 * s, 0.26 * s), rot=(0, 0, sx * 0.2), bevel=0.02 * s, subsurf=1, to=n['torso'])
        P('trim', 'torus', A(0, 0.36, 0), scale=(1, 1, 0.8), R=0.33 * s, r=0.018 * s, seg=16, to=n['torso'])
    h = n['head']
    P('skin', 'sphere', A(0, 1.335, 0), scale=(0.3 * s, 0.33 * s, 0.31 * s), seg=14, to=h); P('skin', 'sphere', A(0, 1.32, 0.15), scale=(0.045 * s, 0.06 * s, 0.05 * s), seg=6, to=h)
    guard = lambda col, r=0.168, drop=0.16: S(col, lambda u, v: A(math.sin((u - 0.5) * 3.5) * (r + v * 0.05), 1.39 - v * drop, -math.cos((u - 0.5) * 3.5) * (r + v * 0.05)), 10, 2, 0.014 * s, 1, to=h)
    if gen:
        P('armor', 'sphere', A(0, 1.4, -0.005), scale=(0.35 * s, 0.27 * s, 0.36 * s), seg=14, to=h); P('trim', 'cone', A(0, 1.43, 0), r1=0.18 * s, r2=0.172 * s, depth=0.1 * s, seg=16, bevel=0.008 * s, to=h)
        P('armor', 'cone', A(0, 1.6, 0), r1=0.13 * s, depth=0.22 * s, seg=12, to=h); P('glow', 'sphere', A(0, 1.46, 0.17), scale=(0.08 * s, 0.08 * s, 0.05 * s), seg=8, to=h)
        for sx in (-1, 1): P('glow', 'cone', A(sx * 0.1, 1.98, -0.2), rot=(-0.55, 0, -sx * 0.3), r1=0.03 * s, depth=0.95 * s, seg=6, subsurf=1, to=h)   # pheasant plumes
        guard('armor')
    elif style == 'guard':
        P('iron', 'sphere', A(0, 1.4, -0.005), scale=(0.35 * s, 0.28 * s, 0.36 * s), seg=14, to=h); P('trim', 'torus', A(0, 1.385, 0), R=0.172 * s, r=0.016 * s, seg=16, to=h)
        P('cloth', 'cone', A(0, 1.63, 0), r1=0.05 * s, depth=0.24 * s, seg=8, to=h); guard('iron', 0.17, 0.2)
    elif style == 'hat':
        P('wood', 'cone', A(0, 1.5, 0), r1=0.31 * s, depth=0.17 * s, seg=16, to=h); P('darkWood', 'torus', A(0, 1.418, 0), R=0.305 * s, r=0.012 * s, seg=16, to=h)
        P('clothDark', 'sphere', A(0, 1.4, -0.01), scale=(0.33 * s, 0.2 * s, 0.34 * s), seg=12, to=h)
    else:
        P('armor', 'sphere', A(0, 1.4, -0.005), scale=(0.35 * s, 0.265 * s, 0.36 * s), seg=14, to=h); P('trim', 'torus', A(0, 1.385, 0), R=0.172 * s, r=0.016 * s, seg=16, to=h)
        P('trim', 'sphere', A(0, 1.54, 0), scale=(0.07 * s, 0.09 * s, 0.07 * s), seg=8, to=h); guard('armor')
    return n, A

def wheel(c, r, name, scythe=0):
    """Spoked wheel on bone `name`, axle along x."""
    P('darkWood', 'torus', c, rot=(0, 0, PI / 2), R=r, r=0.05, seg=20, to=name); P('iron', 'torus', c, rot=(0, 0, PI / 2), R=r + 0.035, r=0.022, seg=20, to=name)
    for i in range(4): P('wood', 'box', c, (0.04, r * 2, 0.055), rot=(i / 4 * PI, 0, 0), to=name)
    P('trim', 'cone', c, rot=(0, 0, PI / 2), r1=0.085, r2=0.07, depth=0.2, seg=10, bevel=0.01, to=name)
    if scythe: P('iron', 'cone', (c[0] + scythe * 0.26, c[1], c[2]), rot=(0, 0, -scythe * PI / 2), scale=(1, 1, 0.3), r1=0.06, depth=0.36, seg=6, to=name)

# ---------- assembly, baking, export ----------
def assemble():
    arm = bpy.data.armatures.new('Rig'); rig = bpy.data.objects.new('Rig', arm); scene().collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig; bpy.ops.object.mode_set(mode='EDIT')
    for name, (parent, pivot) in BONES.items():
        b = arm.edit_bones.new(name); h = T(pivot); b.head = h; b.tail = (h.x, h.y + 0.08, h.z); b.roll = 0
        if parent: b.parent = arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    root = next(iter(BONES)); obs = []
    for key in dict.fromkeys(g for _, g in PARTS):
        group = [o for o, g in PARTS if g == key]
        bpy.ops.object.select_all(action='DESELECT')
        for o in group: o.select_set(True)
        bpy.context.view_layer.objects.active = group[0]; bpy.ops.object.join()
        ob = bpy.context.view_layer.objects.active; ob.name = ob.data.name = f'{key[0]}__{key[1] or root}'
        ob.modifiers.new('arm', 'ARMATURE').object = rig; ob.parent = rig; obs.append(ob)
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004); bpy.ops.object.mode_set(mode='OBJECT')
    return rig, obs

def pose(rig, rot):
    """rot: bone -> game-space Euler (x, y, z) as the choreography writes them (y is not used by any rest pose)."""
    for pb in rig.pose.bones:
        rx, _, rz = rot.get(pb.name, (0, 0, 0))
        pb.rotation_mode = 'YXZ'; pb.rotation_euler = (rx, -rz, 0)
    bpy.context.view_layer.update()

def mask_material(img):
    """Emits (0, edge wear, mud) so a second bake can fill the green and blue channels."""
    m = bpy.data.materials.new('mask'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    def N(t, **kw):
        n = nt.nodes.new(t)
        for k, v in kw.items(): setattr(n, k, v)
        return n
    geo = N('ShaderNodeNewGeometry'); out = N('ShaderNodeOutputMaterial'); em = N('ShaderNodeEmission'); comb = N('ShaderNodeCombineColor')
    bev = N('ShaderNodeBevel', samples=6); bev.inputs['Radius'].default_value = 0.022
    dot = N('ShaderNodeVectorMath', operation='DOT_PRODUCT')
    wear = N('ShaderNodeMapRange'); wear.inputs[1].default_value = 0.985; wear.inputs[2].default_value = 0.86; wear.inputs[3].default_value = 0; wear.inputs[4].default_value = 1
    n1 = N('ShaderNodeTexNoise'); n1.inputs['Scale'].default_value = 28; n1.inputs['Detail'].default_value = 6
    r1 = N('ShaderNodeMapRange'); r1.inputs[1].default_value = 0.36; r1.inputs[2].default_value = 0.6
    mw = N('ShaderNodeMath', operation='MULTIPLY')
    sep = N('ShaderNodeSeparateXYZ'); h = N('ShaderNodeMapRange'); h.inputs[1].default_value = 0.0; h.inputs[2].default_value = 0.6; h.inputs[3].default_value = 1; h.inputs[4].default_value = 0
    n2 = N('ShaderNodeTexNoise'); n2.inputs['Scale'].default_value = 7; n2.inputs['Detail'].default_value = 5
    r2 = N('ShaderNodeMapRange'); r2.inputs[1].default_value = 0.38; r2.inputs[2].default_value = 0.66
    mm = N('ShaderNodeMath', operation='MULTIPLY')
    L = nt.links.new
    L(bev.outputs[0], dot.inputs[0]); L(geo.outputs['Normal'], dot.inputs[1]); L(dot.outputs['Value'], wear.inputs[0]); L(n1.outputs[0], r1.inputs[0]); L(wear.outputs[0], mw.inputs[0]); L(r1.outputs[0], mw.inputs[1])
    L(geo.outputs['Position'], sep.inputs[0]); L(sep.outputs['Z'], h.inputs[0]); L(n2.outputs[0], r2.inputs[0]); L(h.outputs[0], mm.inputs[0]); L(r2.outputs[0], mm.inputs[1])
    L(mw.outputs[0], comb.inputs[1]); L(mm.outputs[0], comb.inputs[2]); L(comb.outputs[0], em.inputs[0]); L(em.outputs[0], out.inputs[0])
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = img; nt.nodes.active = t
    return m

def bake(obs, file, size=1024):
    sc = scene(); sc.render.engine = 'CYCLES'; sc.cycles.samples = 64; sc.cycles.device = 'CPU'
    sc.world = bpy.data.worlds.new('W'); sc.world.light_settings.distance = 0.7
    ground = bpy.data.objects.new('Ground', bpy.data.meshes.new('Ground')); sc.collection.objects.link(ground)
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=8); bm.to_mesh(ground.data); bm.free()
    ao = bpy.data.images.new('ao', size, size, is_data=True); mk = bpy.data.images.new('mask', size, size, is_data=True)
    def run(kind, img):
        for i, ob in enumerate(obs):
            bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
            bpy.ops.object.bake(type=kind, margin=4, use_clear=i == 0)
    nodes = []
    for m in {m for ob in obs for m in ob.data.materials}:
        n = m.node_tree.nodes.new('ShaderNodeTexImage'); n.image = ao; m.node_tree.nodes.active = n; nodes.append((m, n))
    run('AO', ao)
    for m, n in nodes: m.node_tree.nodes.remove(n)
    mm = mask_material(mk); keep = [list(ob.data.materials) for ob in obs]
    for ob in obs:
        for i in range(len(ob.data.materials)): ob.data.materials[i] = mm
    run('EMIT', mk)
    for ob, ms in zip(obs, keep):
        for i, m in enumerate(ms): ob.data.materials[i] = m
    a = np.empty(size * size * 4, dtype=np.float32); b = np.empty_like(a); ao.pixels.foreach_get(a); mk.pixels.foreach_get(b)
    a = a.reshape(-1, 4); b = b.reshape(-1, 4); a[:, 1] = b[:, 1]; a[:, 2] = b[:, 2]; a[:, 3] = 1
    out = bpy.data.images.new(file, size, size, is_data=True); out.pixels.foreach_set(a.ravel())
    out.filepath_raw = os.path.join(OUT, file); out.file_format = 'PNG'; out.save()
    return ground

def render(name, eye, target, ground):
    sc = scene()
    sc.world.use_nodes = True; bg = sc.world.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.55, 0.62, 0.8, 1); bg.inputs[1].default_value = 0.7
    gm = bpy.data.materials.new('floor'); gm.use_nodes = True; gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.3, 0.27, 0.22, 1); ground.data.materials.append(gm)
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 4; sun.data.angle = 0.1; sun.rotation_euler = (0.9, 0.2, -0.8); sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam; cam.data.lens = 55
    sc.render.resolution_x = sc.render.resolution_y = 640; sc.cycles.samples = 32; sc.cycles.use_denoising = True
    cam.location = T(eye); cam.rotation_euler = (T(target) - T(eye)).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = os.path.join(PREVIEW, name + '.png'); bpy.ops.render.render(write_still=True)

def export(name, rest, eye=(2.6, 1.9, 3.4), target=(0, 1.0, 0)):
    rig, obs = assemble()
    pose(rig, rest)
    ground = bake(obs, name + '_ao.png')
    if PREVIEW: os.makedirs(PREVIEW, exist_ok=True); render(name, eye, target, ground)
    pose(rig, {}); bpy.data.objects.remove(ground)
    bpy.ops.object.select_all(action='DESELECT')
    for o in (rig, *obs): o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name + '.glb'), export_format='GLB', use_selection=True, export_yup=True,
                              export_animations=False, export_skins=True, export_materials='EXPORT', export_cameras=False, export_lights=False)
    tris = sum(len(p.vertices) - 2 for o in obs for p in o.data.polygons)
    print(f'DONE {name}: {tris} tris, {len(obs)} meshes, {sum(len(o.data.materials) for o in obs)} primitives, {len(BONES)} bones')

UNITS = {}
def unit(fn): UNITS[fn.__name__] = fn; return fn

# ======================================================================================
# Units. Numbers come from the procedural builders in src/units.ts (same pivots, same sizes).
# ======================================================================================
@unit
def king():
    n, A = human((0, 0, 0), 1, 'general')
    bone('banner', 'torso', (0, 0.82, -0.17))
    part('Banner', 'banner')
    P('trim', 'cone', (0, 1.57, -0.17), r1=0.02, r2=0.02, depth=1.5, seg=8, to='banner'); P('trim', 'sphere', (0, 2.35, -0.17), scale=(0.08, 0.1, 0.08), seg=8, to='banner')
    P('trim', 'box', (0, 2.27, -0.17 - 0.0), (0.03, 0.03, 0.03), to='banner')
    part('Weapon', 'weapon'); o = BONES['weapon'][1]
    P('iron', 'box', (o.x, o.y + 0.5, o.z), (0.06, 0.82, 0.02), bevel=0.008, to='weapon'); P('iron', 'cone', (o.x, o.y + 0.96, o.z), scale=(1, 1, 0.33), r1=0.03, depth=0.1, seg=4, rot=(0, PI / 4, 0), to='weapon')
    P('trim', 'box', (o.x, o.y + 0.075, o.z), (0.22, 0.04, 0.055), bevel=0.012, to='weapon'); P('leather', 'cone', (o.x, o.y - 0.02, o.z), r1=0.022, r2=0.022, depth=0.17, seg=8, to='weapon')
    P('trim', 'sphere', (o.x, o.y - 0.12, o.z), scale=(0.06, 0.06, 0.06), seg=8, to='weapon')
    export('king', {'armR': (0.1, 0, -0.12), 'weapon': (2.2, 0, 0), 'armL': (0, 0, 0.12)}, (1.9, 1.6, 2.6), (0, 0.95, 0))

@unit
def advisor():
    n, A = human((0, 0, 0), 1, 'guard', robe=True)
    P('glow', 'box', (0, 0.42, 0.2), (0.1, 0.5, 0.03), bevel=0.01, to='torso')
    part('Weapon', 'weapon'); polearm('halberd', BONES['weapon'][1], 1, 2.0)
    export('advisor', {'armR': (-0.15, 0, -0.1), 'weapon': (0.15, 0, 0), 'armL': (0, 0, 0.1)}, (1.9, 1.6, 2.6), (0, 1.0, 0))

@unit
def pawn():
    n, A = human((0, 0, 0), 1, 'hat', pads=False)
    c = (-0.37, 0.78, 0.1)   # round shield strapped to the left forearm
    P('cloth', 'cone', c, rot=(PI / 2, 0, 0), r1=0.27, r2=0.27, depth=0.045, seg=16, bevel=0.01, to='armL'); P('trim', 'sphere', (c[0], c[1], c[2] + 0.03), scale=(0.16, 0.16, 0.08), seg=10, to='armL')
    P('trim', 'torus', (c[0], c[1], c[2] + 0.012), rot=(PI / 2, 0, 0), R=0.262, r=0.022, seg=18, to='armL')
    part('Weapon', 'weapon'); polearm('spear', BONES['weapon'][1], 1, 1.75)
    export('pawn', {'armR': (-0.12, 0, -0.08), 'weapon': (0.12, 0, 0), 'armL': (-0.5, 0, 0.15)}, (1.7, 1.4, 2.4), (0, 0.85, 0))

@unit
def horse():
    HB = 0.98
    bone('g', None, (0, 0, 0)); bone('hb', 'g', (0, HB, 0))
    LEGS = [(-0.19, 0.42), (0.19, 0.42), (-0.19, -0.42), (0.19, -0.42)]
    for i, (x, z) in enumerate(LEGS): bone(f'leg{i}', 'hb', (x, HB - 0.14, z)); bone(f'knee{i}', f'leg{i}', (x, HB - 0.56, z))
    bone('neck', 'hb', (0, HB + 0.2, 0.5)); bone('hd', 'neck', (0, HB + 0.7, 0.76)); bone('tail', 'hb', (0, HB + 0.14, -0.6))
    TAIL = [(0, 1.16, -0.62), (0, 1.02, -0.8), (0, 0.78, -0.87), (0, 0.54, -0.86), (0, 0.3, -0.82)]
    for k in (1, 2, 3): bone(f'tail{k}', 'tail' if k == 1 else f'tail{k - 1}', TAIL[k])
    # trunk, neck and head
    ball((0, 1.03, -0.03), (0.265, 0.285, 0.47)); ball((0, 1.0, 0.34), (0.25, 0.32, 0.25)); ball((0, 1.07, -0.4), (0.275, 0.29, 0.27)); ball((0, 1.25, 0.27), (0.11, 0.12, 0.2)); ball((0, 0.9, 0.05), (0.21, 0.19, 0.36))
    capsule((0, 1.14, 0.46), (0, 1.42, 0.65), 0.235, 0.175, 0.76); capsule((0, 1.42, 0.65), (0, 1.68, 0.8), 0.175, 0.12, 0.76)
    ball((0, 1.62, 0.86), (0.095, 0.13, 0.13)); capsule((0, 1.7, 0.88), (0, 1.5, 1.1), 0.1, 0.07, 0.85); ball((0, 1.475, 1.12), (0.07, 0.065, 0.075))
    segs = {'hb': ((0, 1.03, -0.45), (0, 1.03, 0.36), 0.27), 'neck': ((0, 1.2, 0.5), (0, 1.6, 0.76), 0.15), 'hd': ((0, 1.7, 0.86), (0, 1.48, 1.12), 0.09)}
    for i, (x, z) in enumerate(LEGS):
        if z > 0:
            ball((x * 0.95, 0.95, 0.4), (0.105, 0.22, 0.15)); capsule((x, 0.82, 0.42), (x, 0.46, 0.43), 0.085, 0.052); ball((x, 0.435, 0.435), (0.058, 0.065, 0.062)); capsule((x, 0.42, 0.43), (x, 0.15, 0.42), 0.042, 0.038)
        else:
            ball((x * 0.95, 0.93, -0.4), (0.115, 0.26, 0.19)); capsule((x, 0.78, -0.4), (x, 0.47, -0.47), 0.09, 0.05); ball((x, 0.44, -0.475), (0.052, 0.07, 0.066)); capsule((x, 0.43, -0.47), (x, 0.15, -0.43), 0.044, 0.04)
        ball((x, 0.125, z - (0 if z > 0 else 0.01)), (0.05, 0.05, 0.055)); capsule((x, 0.12, z), (x, 0.07, z + 0.025), 0.042, 0.05)
        zk = 0.43 if z > 0 else -0.47
        segs[f'leg{i}'] = ((x, 0.82, z), (x, 0.47, zk), 0.08); segs[f'knee{i}'] = ((x, 0.4, zk), (x, 0.03, z), 0.045)
    soft(blob('coat', 4200), segs, 0.06)
    for i, (x, z) in enumerate(LEGS): P('black', 'cone', (x, 0.038, z + 0.028), scale=(1, 1, 1.15), r1=0.058, r2=0.046, depth=0.075, seg=10, bevel=0.008, to=f'knee{i}')
    def crest(u, v):
        p = Vector((0, 1.27, 0.38)).lerp(Vector((0, 1.79, 0.74)), u); p.y += 0.07 * math.sin(PI * u)
        return p + Vector((0, 0.55, -0.83)) * ((0.05 + 0.1 * math.sin(PI * min(1, u * 1.3)) + 0.025 * math.sin(u * 40)) * v - 0.03)
    m = S('mane', crest, 18, 2, 0.05, 1)
    for v in m.data.vertices: v.co.x -= 0.025
    soft(m, {'neck': ((0, 1.2, 0.45), (0, 1.55, 0.66), 0.05), 'hd': ((0, 1.72, 0.74), (0, 1.8, 0.78), 0.03)}, 0.08)
    P('mane', 'cone', (0, 1.76, 0.9), scale=(0.75, 1, 0.5), rot=(2.5, 0, 0), r1=0.075, depth=0.2, seg=6, subsurf=1, to='hd')
    for sx in (-1, 1):
        P('coat', 'cone', (sx * 0.065, 1.87, 0.8), scale=(1, 1, 0.55), rot=(0.3, 0, -sx * 0.22), r1=0.042, depth=0.15, seg=6, subsurf=1, to='hd')
        P('glow', 'sphere', (sx * 0.082, 1.69, 0.94), scale=(0.03, 0.05, 0.05), seg=6, to='hd'); P('black', 'sphere', (sx * 0.038, 1.5, 1.175), scale=(0.022, 0.028, 0.02), seg=6, to='hd')
    for k in range(4): capsule(TAIL[k], TAIL[k + 1], (0.05, 0.08, 0.09, 0.075)[k], (0.08, 0.09, 0.075, 0.025)[k])
    soft(blob('mane', 500), {('tail' if k == 0 else f'tail{k}'): (TAIL[k], TAIL[k + 1], 0.05) for k in range(4)}, 0.07)
    def blanket(u, v, off=0.0, z0=-0.33, z1=0.2):
        a = (u - 0.5) * 4.3; s = 1 if a > 0 else -1; rx, ry = 0.285 + off, 0.305 + off
        if abs(a) <= 1.45: x, y = math.sin(a) * rx, 1.03 + math.cos(a) * ry
        else: d = abs(a) - 1.45; x, y = s * (math.sin(1.45) * rx + 0.03 * d), 1.03 + math.cos(1.45) * ry - d * 0.36
        return (x, y, z0 + (z1 - z0) * v)
    S('cloth', blanket, 18, 4, 0.016, 1, to='hb')
    for z in (-0.345, 0.185): S('trim', lambda u, v, z=z: blanket(u, v, 0.012, z, z + 0.035), 18, 1, 0.012, 0, to='hb')
    for u0 in (0.0, 0.965): S('trim', lambda u, v, u0=u0: blanket(u0 + u * 0.035, v, 0.012, -0.345, 0.22), 1, 4, 0.012, 0, to='hb')
    pey = lambda u, v: (math.sin((u - 0.5) * 2.7) * 0.262 * math.cos(-0.55 + v * 0.8), 1.0 + math.sin(-0.55 + v * 0.8) * 0.33, 0.34 + math.cos((u - 0.5) * 2.7) * 0.265 * math.cos(-0.55 + v * 0.8))
    S('armor', pey, 10, 4, 0.022, 1, to='hb'); S('trim', lambda u, v: pey(u, 0.96 + v * 0.09), 10, 1, 0.03, 0, to='hb')
    P('trim', 'sphere', (0, 0.93, 0.615), scale=(0.15, 0.15, 0.07), rot=(0.25, 0, 0), seg=10, to='hb')
    F = -PI / 4
    P('trim', 'box', (0, 1.655, 1.045), (0.105, 0.27, 0.022), rot=(F, 0, 0), bevel=0.012, subsurf=1, to='hd'); P('glow', 'sphere', (0, 1.74, 0.985), scale=(0.04, 0.04, 0.03), seg=8, to='hd')
    P('leather', 'torus', (0, 1.535, 1.065), rot=(F, 0, 0), R=0.088, r=0.011, seg=14, to='hd'); P('leather', 'torus', (0, 1.7, 0.9), rot=(F, 0, 0), R=0.122, r=0.011, seg=14, to='hd')
    P('leather', 'box', (0, 1.345, -0.05), (0.32, 0.06, 0.42), bevel=0.03, subsurf=1, to='hb'); P('leather', 'box', (0, 1.39, 0.13), (0.18, 0.11, 0.055), rot=(-0.3, 0, 0), bevel=0.025, subsurf=1, to='hb')
    P('leather', 'box', (0, 1.4, -0.25), (0.28, 0.13, 0.055), rot=(0.35, 0, 0), bevel=0.025, subsurf=1, to='hb'); S('leather', lambda u, v: blanket(u, v, 0.02, -0.02, 0.05), 18, 1, 0.012, 0, to='hb')
    S('leather', lambda u, v: (math.sin((u - 0.5) * 3.0) * 0.285, 1.13 + v * 0.045 - 0.1 * abs(u - 0.5), -0.36 - math.cos((u - 0.5) * 3.0) * 0.31), 10, 1, 0.012, 0, to='hb')
    for sx in (-1, 1): P('trim', 'sphere', (sx * 0.27, 1.12, -0.42), scale=(0.035, 0.09, 0.09), seg=8, to='hb')
    part('Rider', 'rider')
    human((0, HB + 0.36 - 0.62 * 0.8, -0.05), 0.8, 'plain', parent='hb', prefix='r_', root='rider')
    polearm('glaive', BONES['weapon'][1], 0.8, 1.7)
    export('horse', {'r_legL': (-0.5, 0, -0.55), 'r_legR': (-0.5, 0, 0.55), 'r_armR': (-0.2, 0, -0.25), 'r_armL': (-0.7, 0, 0), 'weapon': (0.2, 0, 0)}, (2.6, 1.9, 3.4), (0, 1.1, 0.1))

@unit
def elephant():
    bone('g', None, (0, 0, 0)); bone('eb', 'g', (0, 1.25, 0)); bone('head', 'eb', (0, 1.37, 0.84))
    for i, sx in enumerate((-1, 1)): bone(f'ear{i}', 'head', (sx * 0.36, 1.49, 0.98))
    TY = [1.27 - 0.21 * i for i in range(8)]; TR = [0.15 * 0.86 ** i for i in range(8)]
    for i in range(7): bone(f'trunk{i}', 'head' if i == 0 else f'trunk{i - 1}', (0, TY[i], 1.4))
    LEGS = [(-0.36, 0.56), (0.36, 0.56), (-0.36, -0.56), (0.36, -0.56)]
    for i, (x, z) in enumerate(LEGS): bone(f'leg{i}', 'eb', (x, 0.95, z))
    bone('tail', 'eb', (0, 1.45, -0.9))
    ball((0, 1.25, 0), (0.63, 0.6, 0.93)); ball((0, 1.45, -0.45), (0.5, 0.42, 0.45)); ball((0, 1.5, 0.45), (0.5, 0.42, 0.4))
    ball((0, 1.37, 1.04), (0.42, 0.46, 0.42)); ball((0.17, 1.66, 1.02), (0.2, 0.19, 0.22)); ball((-0.17, 1.66, 1.02), (0.2, 0.19, 0.22)); ball((0, 1.2, 1.32), (0.2, 0.2, 0.17))
    segs = {'eb': ((0, 1.25, -0.6), (0, 1.25, 0.5), 0.56), 'head': ((0, 1.4, 0.95), (0, 1.4, 1.15), 0.38), 'tail': ((0, 1.45, -0.9), (0, 0.85, -1.02), 0.03)}
    for i in range(7): capsule((0, TY[i], 1.4), (0, TY[i + 1], 1.4), TR[i], TR[i + 1]); segs[f'trunk{i}'] = ((0, TY[i] - 0.03, 1.4), (0, TY[i + 1] + 0.03, 1.4), TR[i] * 0.8)
    for i, (x, z) in enumerate(LEGS):
        capsule((x, 0.98, z), (x, 0.16, z), 0.22, 0.2); ball((x, 0.1, z + 0.02), (0.235, 0.1, 0.25)); segs[f'leg{i}'] = ((x, 0.85, z), (x, 0.05, z), 0.2)
    capsule((0, 1.45, -0.9), (0, 0.85, -1.02), 0.045, 0.028)
    soft(blob('hide', 5200, voxel=0.028, smooth=10), segs, 0.085)
    P('mane', 'sphere', (0, 0.8, -1.03), scale=(0.1, 0.2, 0.1), seg=8, to='tail')
    for i, sx in enumerate((-1, 1)):
        P('hide', 'sphere', (sx * 0.7, 1.44, 0.98), scale=(0.72, 0.86, 0.1), rot=(0, -sx * 0.5, 0), seg=14, to=f'ear{i}')
        P('black', 'sphere', (sx * 0.29, 1.47, 1.35), scale=(0.07, 0.07, 0.05), seg=6, to='head')
        d = Vector((sx * 0.1, 0.28, 0.95)).normalized(); base = Vector((sx * 0.22, 1.15, 1.3))   # tusks sweep forward and up
        P('ivory', 'cone', base + d * 0.4, rot=Vector((0, 1, 0)).rotation_difference(d).to_euler('XYZ'), r1=0.075, r2=0.012, depth=0.8, seg=10, to='head')
        P('trim', 'cone', base + d * 0.1, rot=Vector((0, 1, 0)).rotation_difference(d).to_euler('XYZ'), r1=0.082, r2=0.078, depth=0.09, seg=8, to='head')
    for i, (x, z) in enumerate(LEGS): P('trim', 'torus', (x, 0.2, z), R=0.215, r=0.028, seg=14, to=f'leg{i}')
    P('trim', 'box', (0, 1.6, 1.44), (0.42, 0.36, 0.05), rot=(-0.5, 0, 0), bevel=0.02, subsurf=1, to='head'); P('glow', 'sphere', (0, 1.62, 1.48), scale=(0.14, 0.14, 0.08), seg=8, to='head')
    def blanket(u, v, off=0.0, z0=-0.52, z1=0.46):
        a = (u - 0.5) * 4.1; s = 1 if a > 0 else -1; rx, ry = 0.645 + off, 0.615 + off
        if abs(a) <= 1.45: x, y = math.sin(a) * rx, 1.27 + math.cos(a) * ry
        else: d = abs(a) - 1.45; x, y = s * (math.sin(1.45) * rx + 0.04 * d), 1.27 + math.cos(1.45) * ry - d * 0.7
        return (x, y, z0 + (z1 - z0) * v)
    S('cloth', blanket, 18, 4, 0.03, 1, to='eb')
    for z in (-0.55, 0.42): S('trim', lambda u, v, z=z: blanket(u, v, 0.02, z, z + 0.07), 18, 1, 0.02, 0, to='eb')
    for u0 in (0.0, 0.955): S('trim', lambda u, v, u0=u0: blanket(u0 + u * 0.045, v, 0.02, -0.55, 0.49), 1, 4, 0.02, 0, to='eb')
    H = 1.87   # howdah
    P('trim', 'box', (0, H, -0.05), (0.98, 0.1, 0.98), bevel=0.02, to='eb')
    for w, d, x, z in ((0.95, 0.06, 0, 0.45), (0.95, 0.06, 0, -0.45), (0.06, 0.95, 0.45, 0), (0.06, 0.95, -0.45, 0)): P('armor', 'box', (x, H + 0.18, z - 0.05), (w, 0.28, d), bevel=0.015, to='eb')
    for sx in (-1, 1):
        for sz in (-1, 1): P('trim', 'cone', (sx * 0.43, H + 0.55, sz * 0.43 - 0.05), r1=0.028, r2=0.028, depth=1.0, seg=6, to='eb')
    P('cloth', 'cone', (0, H + 1.24, -0.05), rot=(0, PI / 4, 0), r1=0.84, depth=0.42, seg=4, bevel=0.02, to='eb'); P('trim', 'box', (0, H + 1.035, -0.05), (1.08, 0.04, 1.08), bevel=0.01, to='eb')
    P('glow', 'sphere', (0, H + 1.49, -0.05), scale=(0.14, 0.16, 0.14), seg=8, to='eb')
    part('Rider', 'rider')
    human((0, H - 0.2, -0.05), 0.72, 'plain', parent='eb', prefix='r_', root='rider')
    polearm('spear', BONES['weapon'][1], 0.72, 1.5)
    rest = {f'trunk{i}': ((-0.25 if i == 0 else -0.35 if i > 4 else 0.02), 0, 0) for i in range(7)}
    export('elephant', {**rest, 'r_armR': (-0.2, 0, -0.2), 'weapon': (0.2, 0, 0)}, (4.2, 2.6, 5.0), (0, 1.5, 0.2))

@unit
def chariot():
    Y = 0.5
    bone('cb', None, (0, Y, 0))
    for nme, p in (('deck', (0, Y, 0)), ('front', (0, Y + 0.35, 0.72)), ('sideL', (-0.45, Y + 0.3, 0.03)), ('sideR', (0.45, Y + 0.3, 0.03)), ('ram', (0, Y + 0.08, 1.2)), ('parasol', (0, Y + 0.85, -0.42)), ('pole', (0.4, Y + 0.75, -0.7))): bone(nme, 'cb', p)
    W = [(-1, 1), (1, 1), (-1, -1), (1, -1)]
    for i, (sx, sz) in enumerate(W): bone(f'wheel{i}', 'cb', (sx * 0.6, Y - 0.08, sz * 0.48))
    part('Deck', 'deck')
    P('wood', 'box', (0, Y, 0), (0.95, 0.18, 1.5), bevel=0.02, to='deck')
    for sz in (-1, 1): P('darkWood', 'cone', (0, Y - 0.08, sz * 0.48), rot=(0, 0, PI / 2), r1=0.045, r2=0.045, depth=1.24, seg=8, to='deck')
    for x in (-0.3, 0, 0.3): P('darkWood', 'box', (x, Y + 0.095, 0), (0.04, 0.02, 1.46), to='deck')   # deck planks
    part('Front', 'front')
    P('armor', 'box', (0, Y + 0.35, 0.72), (0.98, 0.52, 0.08), bevel=0.02, to='front'); P('trim', 'sphere', (0, Y + 0.36, 0.775), scale=(0.28, 0.28, 0.1), seg=12, to='front')
    P('trim', 'box', (0, Y + 0.625, 0.72), (1.02, 0.05, 0.11), bevel=0.012, to='front')
    for sx in (-1, 1): P('trim', 'sphere', (sx * 0.36, Y + 0.36, 0.765), scale=(0.09, 0.09, 0.05), seg=8, to='front')
    for sx, nme in ((-1, 'sideL'), (1, 'sideR')):
        part('Side' + nme[-1], nme)
        P('armor', 'box', (sx * 0.45, Y + 0.3, 0.03), (0.08, 0.42, 1.36), bevel=0.015, to=nme); P('trim', 'box', (sx * 0.45, Y + 0.53, 0.03), (0.1, 0.05, 1.4), bevel=0.012, to=nme)
        for i in range(3): P('trim', 'sphere', (sx * 0.495, Y + 0.3, -0.4 + i * 0.42), scale=(0.1, 0.1, 0.1), seg=8, to=nme)
    part('Ram', 'ram')
    P('darkWood', 'cone', (0, Y + 0.08, 1.05), rot=(PI / 2, 0, 0), r1=0.11, r2=0.09, depth=0.8, seg=10, to='ram')
    P('bronze', 'cone', (0, Y + 0.08, 1.6), rot=(PI / 2, 0, 0), r1=0.2, depth=0.42, seg=8, subsurf=1, to='ram'); P('bronze', 'cone', (0, Y + 0.08, 1.4), rot=(PI / 2, 0, 0), r1=0.21, r2=0.2, depth=0.08, seg=10, bevel=0.01, to='ram')
    for sx in (-1, 1):
        P('ivory', 'cone', (sx * 0.14, Y + 0.24, 1.46), rot=(0.5, 0, -sx * 0.5), r1=0.045, depth=0.28, seg=6, to='ram'); P('glow', 'sphere', (sx * 0.095, Y + 0.17, 1.56), scale=(0.07, 0.07, 0.07), seg=6, to='ram')
    part('Parasol', 'parasol')
    P('trim', 'cone', (0, Y + 0.85, -0.42), r1=0.024, r2=0.024, depth=1.5, seg=8, to='parasol'); P('cloth', 'cone', (0, Y + 1.69, -0.42), r1=0.63, depth=0.22, seg=14, to='parasol')
    P('trim', 'torus', (0, Y + 1.58, -0.42), R=0.63, r=0.02, seg=18, to='parasol'); P('glow', 'sphere', (0, Y + 1.82, -0.42), scale=(0.08, 0.1, 0.08), seg=8, to='parasol')
    part('Pole', 'pole')
    P('trim', 'cone', (0.4, Y + 0.75, -0.7), r1=0.02, r2=0.02, depth=1.3, seg=8, to='pole'); P('trim', 'sphere', (0.4, Y + 1.43, -0.7), scale=(0.07, 0.09, 0.07), seg=8, to='pole')
    for i, (sx, sz) in enumerate(W): part(f'Wheel{i}', f'wheel{i}'); wheel((sx * 0.6, Y - 0.08, sz * 0.48), 0.36, f'wheel{i}', sx)
    part('Rider', 'rider')
    human((0, Y + 0.09, 0.1), 0.85, 'plain', parent='cb', prefix='r_', root='rider')
    polearm('ge', BONES['weapon'][1], 0.85, 1.8)
    export('chariot', {'r_armR': (-0.2, 0, -0.2), 'weapon': (0.2, 0, 0), 'r_armL': (-0.9, 0, 0.2)}, (3.0, 2.2, 3.8), (0, 1.1, 0.2))

@unit
def cannon():
    bone('cb', None, (0, 0, 0)); bone('trail', 'cb', (0, 0.3, -0.4)); bone('balls', 'cb', (0.69, 0.1, -0.41))
    bone('barrel', 'cb', (0, 0.68, 0.05)); bone('muzzle', 'barrel', (0, 0.68, 1.15))
    for i, sx in enumerate((-1, 1)): bone(f'wheel{i}', 'cb', (sx * 0.48, 0.42, 0.05))
    part('Trail', 'trail')
    P('wood', 'box', (0, 0.26, -0.5), (0.2, 0.13, 1.15), rot=(-0.3, 0, 0), bevel=0.02, to='trail')
    for sx in (-1, 1): P('wood', 'box', (sx * 0.22, 0.55, 0.05), (0.08, 0.3, 0.55), bevel=0.02, to='trail'); P('iron', 'box', (sx * 0.22, 0.71, 0.05), (0.1, 0.03, 0.2), bevel=0.008, to='trail')
    P('darkWood', 'cone', (0, 0.42, 0.05), rot=(0, 0, PI / 2), r1=0.05, r2=0.05, depth=1.02, seg=8, to='trail'); P('iron', 'torus', (0, 0.1, -1.0), rot=(0.3, 0, 0), R=0.07, r=0.018, seg=10, to='trail')
    part('Balls', 'balls')
    for x, y, z in ((0.62, 0.1, -0.5), (0.78, 0.1, -0.4), (0.68, 0.1, -0.33), (0.69, 0.25, -0.41)): P('black', 'sphere', (x, y, z), scale=(0.2, 0.2, 0.2), seg=10, to='balls')
    part('Barrel', 'barrel'); B = (0, 0.68)
    R = lambda z: 0.2 - (z + 0.35) * 0.05   # bore tapers towards the muzzle
    P('bronze', 'cone', (0, 0.68, 0.35), rot=(PI / 2, 0, 0), r1=0.2, r2=0.13, depth=1.4, seg=16, to='barrel')
    for z in (-0.2, 0.25, 0.67): P('trim', 'torus', (0, 0.68, z + 0.05), rot=(PI / 2, 0, 0), R=R(z), r=0.03, seg=16, to='barrel')
    P('trim', 'cone', (0, 0.68, 1.03), rot=(PI / 2, 0, 0), r1=0.15, r2=0.185, depth=0.16, seg=16, bevel=0.01, to='barrel'); P('black', 'cone', (0, 0.68, 1.112), rot=(PI / 2, 0, 0), r1=0.1, r2=0.1, depth=0.01, seg=12, to='barrel')
    P('bronze', 'sphere', (0, 0.68, -0.37), scale=(0.3, 0.3, 0.24), seg=12, to='barrel'); P('bronze', 'sphere', (0, 0.68, -0.52), scale=(0.11, 0.11, 0.13), seg=8, to='barrel')
    P('glow', 'sphere', (0, 0.88, -0.25), scale=(0.08, 0.08, 0.08), seg=6, to='barrel')
    for sx in (-1, 1): P('bronze', 'cone', (sx * 0.2, 0.68, 0.05), rot=(0, 0, PI / 2), r1=0.05, r2=0.05, depth=0.12, seg=8, to='barrel')   # trunnions
    for i, sx in enumerate((-1, 1)): part(f'Wheel{i}', f'wheel{i}'); wheel((sx * 0.48, 0.42, 0.05), 0.38, f'wheel{i}')
    part('Rider', 'rider')
    human((-0.72, 0, -0.42), 0.84, 'plain', parent='cb', prefix='r_', root='rider', pads=False)
    o = BONES['weapon'][1]; bone('torch', 'weapon', (o.x, o.y + 0.52 * 0.84, o.z))
    P('darkWood', 'cone', (o.x, o.y + 0.2 * 0.84, o.z), r1=0.02, r2=0.02, depth=0.6 * 0.84, seg=6, to='weapon'); P('glow', 'sphere', (o.x, o.y + 0.52 * 0.84, o.z), scale=(0.11, 0.11, 0.11), seg=8, to='torch')
    export('cannon', {'barrel': (-0.08, 0, 0), 'r_armR': (-0.5, 0, -0.1), 'weapon': (0.3, 0, 0), 'r_armL': (0, 0, 0.1)}, (2.6, 1.7, 3.0), (-0.2, 0.7, 0.1))

for name in (ONLY or UNITS):
    begin(); UNITS[name]()
