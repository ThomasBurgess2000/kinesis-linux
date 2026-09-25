// The hand that mirrors the band: port of upstream's HandSceneView and HandRig. It lights the
// fingertips of the gesture, acts gestures out, holds a pinch as long as you do, and rolls around
// the pinch for the dial. Poses are upstream's; the rig moves between them on critically damped
// springs, so a new gesture bends the motion already under way.
//
// Drive it with `hand`, `highlight` ("none" | "index" | "middle"), `sustained` (a pinch is held),
// `roll` (degrees, while dialing), and play(gesture) for each recognized gesture. The cursor page
// also turns the whole hand with the forearm: `aimLeft` and `aimUp`, in degrees from rest.

import QtQuick
import QtQuick3D
import org.kde.kirigami as Kirigami
import "handdata.js" as HandData

Item {
    id: view

    property string hand: "right"
    property string highlight: "none"
    property bool sustained: false
    property real roll: 0
    /// Upstream frames the overview hand with 0.72 of the view to spare, and setup's with 0.7.
    property real margin: 0.72
    /// Degrees the forearm has turned from rest, left and up, for a hand that mirrors the arm.
    property real aimLeft: 0
    property real aimUp: 0
    Behavior on aimLeft { NumberAnimation { duration: 80 } }
    Behavior on aimUp { NumberAnimation { duration: 80 } }

    // --- poses (HandRig.swift): finger curls, thumb base (x, y, z), thumb middle, thumb end, roll ---
    readonly property var relaxed: pose([18, 24, 12], [22, 28, 14], [26, 32, 16], [30, 34, 18], [0, 0, 0], 8, 10)
    readonly property var pinchIndex: pose([42, 52, 26], [22, 28, 14], [26, 32, 16], [30, 34, 18], [-26.9, 7.3, -1.6], 15, 5)
    readonly property var pinchMiddle: pose([8, 14, 8], [48, 56, 28], [26, 32, 16], [30, 34, 18], [-33.1, 10.1, -2.1], 19.1, 6.2)
    readonly property var swipeRest: swipePose([50, 70, 35], [-24.2, -4.2, -3.8], 11.0, 10.4)
    readonly property var swipeLeft: swipePose([50, 70, 35], [-25.7, 6.3, -0.2], 8.6, 6.7)
    readonly property var swipeRight: swipePose([50, 70, 35], [-21.9, -14.1, 0.1], 11.0, 19.2)
    readonly property var swipeUp: swipePose([50, 70, 35], [15.9, -40.0, -25.0], -8.0, -11.5)
    readonly property var swipeDown: swipePose([48.6, 53.0, 26.5], [-6.4, -1.7, 3.0], 35.3, 62.8)

    function pose(index, middle, ring, pinky, thumbBase, thumbMiddle, thumbEnd) {
        return [...index, ...middle, ...ring, ...pinky, ...thumbBase, thumbMiddle, thumbEnd, 0];
    }
    /// A loose fist with the thumb's pad on the side of the index finger.
    function swipePose(index, thumbBase, thumbMiddle, thumbEnd) {
        return pose(index, [56, 76, 38], [60, 80, 40], [64, 82, 42], thumbBase, thumbMiddle, thumbEnd);
    }
    function point(p) {
        return Qt.vector3d(p[0], p[1], p[2]);
    }
    function blend(from, to, amount) {
        return from.map((value, i) => value + (to[i] - value) * amount);
    }
    function withRoll(p, degrees) {
        const copy = p.slice();
        copy[17] = degrees;
        return copy;
    }
    function pinchFor(finger) {
        return finger === "middle" ? pinchMiddle : pinchIndex;
    }
    /// A swipe acted out: each pose, and how many milliseconds the hand heads for it. Left and right
    /// start from the far end of the finger; down reaches up first, so the thumb goes over the finger.
    function swipeKeys(direction) {
        const ends = { left: swipeLeft, right: swipeRight, up: swipeUp, down: swipeDown };
        const starts = { left: swipeRight, right: swipeLeft, up: swipeRest, down: swipeRest };
        if (direction === "down") return [[swipeRest, 110], [blend(swipeRest, swipeUp, 0.4), 130], [swipeDown, 340]];
        return [[starts[direction], 150], [ends[direction], 330]];
    }

    // --- the rig: springs on every angle ---
    property var current: relaxed.slice()
    property var velocity: new Array(18).fill(0)
    property var target: relaxed.slice()
    property bool moving: false
    readonly property real frequency: 34

    function moveTo(p) {
        target = p.slice();
        moving = true;
    }

    function step(dt) {
        const pieces = Math.max(1, Math.ceil(dt / 0.004));
        const slice = dt / pieces;
        let settled = true;
        const c = current, v = velocity;
        for (let i = 0; i < 18; i++) {
            for (let n = 0; n < pieces; n++) {
                const offset = c[i] - target[i];
                v[i] += (-frequency * frequency * offset - 2 * frequency * v[i]) * slice;
                c[i] += v[i] * slice;
            }
            if (Math.abs(c[i] - target[i]) > 0.05 || Math.abs(v[i]) > 0.5) settled = false;
        }
        if (settled) {
            current = target.slice();
            velocity = new Array(18).fill(0);
            moving = false;
        }
        apply(current);
    }

    property var joints: []
    property var restRotations: []

    function turnJoint(name, x, y, z) {
        const i = HandData.names.indexOf(name);
        if (i < 0 || !joints[i]) return;
        const turn = Quaternion.fromAxisAndAngle(Qt.vector3d(1, 0, 0), x)
            .times(Quaternion.fromAxisAndAngle(Qt.vector3d(0, 1, 0), y))
            .times(Quaternion.fromAxisAndAngle(Qt.vector3d(0, 0, 1), z));
        joints[i].rotation = restRotations[i].times(turn);
    }

    function apply(values) {
        if (joints.length === 0) return;
        ["index", "middle", "ring", "pinky"].forEach((finger, f) => {
            turnJoint(finger + "-finger-phalanx-proximal", -values[f * 3], 0, 0);
            turnJoint(finger + "-finger-phalanx-intermediate", -values[f * 3 + 1], 0, 0);
            turnJoint(finger + "-finger-phalanx-distal", -values[f * 3 + 2], 0, 0);
        });
        turnJoint("thumb-metacarpal", values[12], values[13], values[14]);
        turnJoint("thumb-phalanx-proximal", -values[15], 0, 0);
        turnJoint("thumb-phalanx-distal", -values[16], 0, 0);
        rollNode.rotation = Quaternion.fromAxisAndAngle(
            Qt.vector3d(HandData.forearm[0], HandData.forearm[1], HandData.forearm[2]), values[17]);
    }

    FrameAnimation {
        running: view.moving && view.visible
        onTriggered: view.step(Math.min(frameTime, 1 / 30))
    }

    // --- choreography (HandSceneView.Coordinator) ---
    property string shownHighlight: "none"
    property bool shownSustained: false
    property real releasedAt: -Infinity
    property var sequence: []

    onSustainedChanged: update(null)
    onHighlightChanged: update(null)
    onRollChanged: if (sustained) moveTo(withRoll(pinchFor(highlight), roll))

    /// A recognized gesture: light its fingertips and act it out.
    function play(gesture) {
        update(gesture);
    }

    function update(gesture) {
        const fired = gesture !== null;
        const held = sustained !== shownSustained;
        if (sustained) moveTo(withRoll(pinchFor(highlight), roll));
        if (highlight === shownHighlight && !fired && !held) return;
        const releasing = shownSustained && !sustained && !fired;
        const now = Date.now() / 1000;
        if (shownSustained && !sustained) releasedAt = now;
        shownHighlight = highlight;
        shownSustained = sustained;
        act(fired ? gesture : null, held, now);
        glowFor(highlight, releasing);
    }

    /// A held pinch is mirrored as it happens. A tap that was just mirrored is not acted out a
    /// second time. Swipes have no live signal, so they replay.
    function act(gesture, held, now) {
        if (sustained) { runSequence([]); return; }
        if (held && !gesture) { runSequence([]); moveTo(relaxed); return; }
        if (!gesture) return;
        if (gesture.kind === "swipe") {
            runSequence(swipeKeys(gesture.key.split(":")[1]).concat([[relaxed, 0]]));
            return;
        }
        const tap = gesture.key.split(":")[1];
        if (now - releasedAt < 0.45) { runSequence([]); moveTo(relaxed); return; }
        const pinch = pinchFor(tap.startsWith("middle") ? "middle" : "index");
        const keys = [[pinch, 150]];
        // Double taps and the hold pinch twice; a plain tap once.
        if (tap !== "indexTap" && tap !== "middleTap") keys.push([blend(relaxed, pinch, 0.4), 110], [pinch, 150]);
        keys.push([relaxed, 0]);
        runSequence(keys);
    }

    function runSequence(keys) {
        keyTimer.stop();
        sequence = keys;
        nextKey();
    }
    function nextKey() {
        if (sequence.length === 0) return;
        const [p, hold] = sequence[0];
        sequence = sequence.slice(1);
        moveTo(p);
        if (sequence.length > 0) {
            keyTimer.interval = hold;
            keyTimer.start();
        }
    }
    Timer { id: keyTimer; onTriggered: view.nextKey() }

    // Fingertip glow: in quickly, a moment's hold, then out, unless a pinch is being held.
    property real thumbLight: 0
    property real indexLight: 0
    property real middleLight: 0
    property real targetThumb: 0
    property real targetIndex: 0
    property real targetMiddle: 0

    function glowFor(which, releasing) {
        glow.stop();
        holdTimer.stop();
        glowOut.stop();
        if (which === "none" || releasing) {
            targetThumb = 0; targetIndex = 0; targetMiddle = 0;
            glowOut.duration = 250;
            glowOut.start();
            return;
        }
        targetThumb = 1;
        targetIndex = which === "index" ? 1 : 0;
        targetMiddle = which === "middle" ? 1 : 0;
        glow.start();
    }

    SequentialAnimation {
        id: glow
        ParallelAnimation {
            NumberAnimation { target: view; property: "thumbLight"; to: view.targetThumb; duration: 80; easing.type: Easing.InOutCubic }
            NumberAnimation { target: view; property: "indexLight"; to: view.targetIndex; duration: 80; easing.type: Easing.InOutCubic }
            NumberAnimation { target: view; property: "middleLight"; to: view.targetMiddle; duration: 80; easing.type: Easing.InOutCubic }
        }
        ScriptAction { script: if (!view.sustained) holdTimer.start() }
    }
    Timer { id: holdTimer; interval: 260; onTriggered: { glowOut.duration = 500; glowOut.start(); } }
    ParallelAnimation {
        id: glowOut
        property int duration: 500
        NumberAnimation { target: view; property: "thumbLight"; to: 0; duration: glowOut.duration; easing.type: Easing.InOutCubic }
        NumberAnimation { target: view; property: "indexLight"; to: 0; duration: glowOut.duration; easing.type: Easing.InOutCubic }
        NumberAnimation { target: view; property: "middleLight"; to: 0; duration: glowOut.duration; easing.type: Easing.InOutCubic }
    }

    // --- the scene ---
    View3D {
        id: view3d
        anchors.fill: parent
        environment: SceneEnvironment {
            backgroundMode: SceneEnvironment.Transparent
            antialiasingMode: SceneEnvironment.MSAA
            antialiasingQuality: SceneEnvironment.High
            tonemapMode: SceneEnvironment.TonemapModeNone
        }

        OrthographicCamera {
            id: camera
            z: 10
            clipNear: 0.1
            clipFar: 100
            readonly property real magnification: Math.max(1, view3d.height) / (2 * HandData.reach / view.margin)
            horizontalMagnification: magnification
            verticalMagnification: magnification
        }

        // A left hand is drawn mirrored, with its fingers to the right. Seen from the thumb side,
        // the fingers point where the arm points: raising it tilts them up in the picture, and
        // turning it left swings them toward the wearer's left.
        Node {
            id: handRoot
            scale: Qt.vector3d(view.hand === "left" ? -1 : 1, 1, 1)
            rotation: Quaternion.fromAxisAndAngle(Qt.vector3d(0, 1, 0), view.aimLeft)
                .times(Quaternion.fromAxisAndAngle(Qt.vector3d(0, 0, 1), view.hand === "left" ? view.aimUp : -view.aimUp))
            // The dial is a knob held in a pinch: the hand turns around the pinch, along the forearm.
            Node {
                id: rollNode
                position: Qt.vector3d(HandData.pivot[0], HandData.pivot[1], HandData.pivot[2])
                Node {
                    position: Qt.vector3d(-HandData.pivot[0], -HandData.pivot[1], -HandData.pivot[2])
                    Node {
                        id: posed
                        position: Qt.vector3d(HandData.view.position[0], HandData.view.position[1], HandData.view.position[2])
                        rotation: Qt.quaternion(HandData.view.rotation[0], HandData.view.rotation[1],
                                                HandData.view.rotation[2], HandData.view.rotation[3])
                    }
                }
            }
        }

        Model {
            source: "../hand/hand.mesh"
            skin: Skin { id: skin }
            materials: CustomMaterial {
                id: material
                shadingMode: CustomMaterial.Unshaded
                vertexShader: "hand.vert"
                fragmentShader: "hand.frag"
                cullMode: Material.NoCulling
                // Only the nearest surface blends in, as SceneKit's single-layer transparency does.
                depthDrawMode: Material.OpaquePrePassDepthDraw
                sourceBlend: CustomMaterial.One
                destinationBlend: CustomMaterial.OneMinusSrcAlpha
                property real thumbLight: view.thumbLight
                property real indexLight: view.indexLight
                property real middleLight: view.middleLight
                property real darkAppearance: Kirigami.Theme.backgroundColor.hslLightness < 0.5 ? 1 : 0
                property color glowColor: Kirigami.Theme.highlightColor
                property vector3d thumbTip: view.point(HandData.restTips.thumb)
                property vector3d indexTip: view.point(HandData.restTips.index)
                property vector3d middleTip: view.point(HandData.restTips.middle)
                property matrix4x4 meshToHand: Qt.matrix4x4(...HandData.meshToHand)
            }
        }
    }

    Component {
        id: jointComponent
        Node {}
    }

    // Nothing may fire into a hand that's being torn down.
    Component.onDestruction: {
        keyTimer.stop();
        holdTimer.stop();
        glow.stop();
        glowOut.stop();
        moving = false;
    }

    // Rebuild the finger chains: the model stores its joints flat.
    Component.onCompleted: {
        const created = [];
        const rests = [];
        for (let i = 0; i < HandData.names.length; i++) {
            const rest = HandData.rest[i];
            const parentNode = HandData.parents[i] < 0 ? posed : created[HandData.parents[i]];
            const rotation = Qt.quaternion(rest.rotation[0], rest.rotation[1], rest.rotation[2], rest.rotation[3]);
            created.push(jointComponent.createObject(parentNode, {
                objectName: HandData.names[i],
                position: Qt.vector3d(rest.position[0], rest.position[1], rest.position[2]),
                rotation: rotation,
                scale: Qt.vector3d(rest.scale[0], rest.scale[1], rest.scale[2]),
            }));
            rests.push(rotation);
        }
        skin.inverseBindPoses = HandData.inverseBindPoses.map((m) => Qt.matrix4x4(...m));
        skin.joints = created;
        restRotations = rests;
        joints = created;
        apply(current);
    }
}
