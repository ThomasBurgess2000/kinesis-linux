// Skins the hand (a custom vertex shader has to) and hands hand.frag the surface's scene-space
// normal, plus where the vertex sits in the resting hand: upstream bakes the fingertip glow and the
// wrist fade at rest, so they ride the fingers wherever the rig takes them.

VARYING vec3 sceneNormal;
VARYING vec3 restPosition;

void MAIN()
{
    mat4 skin = BONE_TRANSFORMS[int(JOINTS.x)] * WEIGHTS.x
              + BONE_TRANSFORMS[int(JOINTS.y)] * WEIGHTS.y
              + BONE_TRANSFORMS[int(JOINTS.z)] * WEIGHTS.z
              + BONE_TRANSFORMS[int(JOINTS.w)] * WEIGHTS.w;
    mat3 skinNormal = mat3(BONE_NORMAL_TRANSFORMS[int(JOINTS.x)] * WEIGHTS.x
                         + BONE_NORMAL_TRANSFORMS[int(JOINTS.y)] * WEIGHTS.y
                         + BONE_NORMAL_TRANSFORMS[int(JOINTS.z)] * WEIGHTS.z
                         + BONE_NORMAL_TRANSFORMS[int(JOINTS.w)] * WEIGHTS.w);
    sceneNormal = normalize(skinNormal * NORMAL);
    restPosition = (meshToHand * vec4(VERTEX, 1.0)).xyz;
    POSITION = VIEWPROJECTION_MATRIX * (skin * vec4(VERTEX, 1.0));
}
