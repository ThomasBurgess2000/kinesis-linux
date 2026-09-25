# the overview hand

`right-hand.glb` is the WebXR generic hand, copied unmodified from
https://github.com/immersive-web/webxr-input-profiles/tree/main/packages/assets/profiles/generic-hand
(retrieved September 14, 2026; MIT, see `Hand-LICENSE.txt`).
SHA256: 291790c14f7f88a7f9bd35330c47392ed8e8d395ae6728f4bb7089f1bc1f2b96

`hand.json` is the Mac app's export of the same hand (`Sources/Kinesis/Resources/hand.json`): each
joint's rest transform in the app's hand space and its parent, plus the fingertips.

`build-hand.py` turns them into what the app loads:

- `hand.mesh`: the skinned mesh, converted by Qt's `balsam`
- `../qml/handdata.js`: the joint chains and rest poses, the inverse bind poses, the mesh-to-hand
  map the shader uses to light fingertips and fade the wrist, and the framing (the relaxed hand seen
  from the thumb side, as upstream frames it)

The app only needs those outputs. To rebuild them (after changing the model or `hand.json`):

```sh
sudo apt install qt6-quick3d-dev-tools qt6-quick3d-assetimporters-plugin python3-numpy
ui/hand/build-hand.py
```

The poses are an illustration of each gesture, not an estimate of your joint angles.
