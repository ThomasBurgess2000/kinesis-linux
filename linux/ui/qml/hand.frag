// The hand's surface, after upstream's HandSceneView: a pale hand with a little cool shade and rim,
// fingertips that light in the glow colour, and a wrist that fades out. Mixed in linear light.

VARYING vec3 sceneNormal;
VARYING vec3 restPosition;

float tipInfluence(vec3 tip)
{
    float t = clamp((distance(restPosition, tip) - 0.08) / 0.62, 0.0, 1.0);
    return 1.0 - t * t * (3.0 - 2.0 * t);
}

void MAIN()
{
    float alongHand = max(0.0, restPosition.y) / 3.4143;
    float fade = smoothstep(0.02, 0.4, alongHand);
    vec3 normal = normalize(sceneNormal);
    float rim = pow(1.0 - abs(dot(normal, -CAMERA_DIRECTION)), 2.0);
    float shade = 0.5 + 0.5 * max(0.0, dot(normal, normalize(vec3(-0.4, 0.6, 1.0))));
    float glow = max(tipInfluence(thumbTip) * thumbLight,
                     max(tipInfluence(indexTip) * indexLight, tipInfluence(middleTip) * middleLight));
    // A white hand on the light field; porcelain in low light on the dark one, never a white cutout.
    vec3 paleLight = mix(vec3(0.99, 0.99, 0.992), vec3(0.72, 0.745, 0.775), 1.0 - shade) * (1.0 - 0.3 * rim);
    vec3 paleDark = mix(vec3(0.63, 0.655, 0.68), vec3(0.215, 0.232, 0.25), 1.0 - shade) + 0.10 * rim;
    vec3 skin = mix(paleLight, paleDark, darkAppearance);
    vec3 colour = mix(skin, pow(glowColor.rgb, vec3(2.2)), glow * 0.92);
    // Premultiplied in display space, so the wrist fades out in the hand's own colour. The depth
    // pre-pass (upstream's single-layer transparency) has no colour to write.
#if !QSSG_ENABLE_DEPTH_PASS
    FRAGCOLOR = vec4(pow(colour, vec3(1.0 / 2.2)) * fade, fade);
#endif
}
