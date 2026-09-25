// Overview is a mirror. The hand shows what the band just felt, the words beside it say what that
// was and what it did, and the list underneath shows what every gesture will do. Port of the Mac
// app's OverviewPage.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.kirigamiaddons.formcard as FormCard

QQC2.ScrollView {
    id: overviewPage

    readonly property var ctl: daemon.state.controller || ({})
    readonly property bool live: ctl.live === true
    /// The last gesture the band recognized: {kind, key, label, action, actionTitle}.
    property var recognized: null
    /// Degrees the wrist has turned since the pinch began, as the band's gyro estimates them.
    property real wristTurn: 0
    /// The light on the ring travels further than the wrist, so a small turn is easy to see.
    readonly property real ringGain: 2.5
    readonly property bool dialing: ctl.dialEngaged === true && live
    property real glow: 0

    readonly property string highlight: {
        if (!live) return "none";
        if (ctl.pinchedFinger) return ctl.pinchedFinger === "middle" ? "middle" : "index";
        if (ctl.dialEngaged) return "index";
        if (!recognized) return "none";
        if (recognized.kind === "swipe") return "index";
        return recognized.key.startsWith("tap:middle") ? "middle" : "index";
    }

    /// What the band just felt, in three words; the one that names the motion carries the weight.
    readonly property var words: {
        if (!live) return ["waiting for your ", "band", ""];
        if (ctl.dialEngaged) return ["index pinch + ", "turn", ""];
        if (!recognized) return ["waiting for a ", "gesture", ""];
        const label = recognized.label.toLowerCase();
        if (recognized.kind === "swipe") return ["thumb ", "swipe", label.replace("swipe", "")];
        const space = label.indexOf(" ");
        return [label.slice(0, space + 1), label.slice(space + 1), ""];
    }

    /// What that did, or null before anything happened.
    readonly property string outcome: {
        if (!live) return "";
        if (ctl.dialEngaged) {
            const target = (daemon.config.dial || {}).target || "none";
            if (target === "none") return "unassigned";
            const targets = daemon.catalog.dialTargets || [];
            const match = targets.find((t) => t.id === target);
            return (match ? match.title : target).toLowerCase();
        }
        if (!recognized) return "";
        return recognized.action === "none" ? "unassigned" : recognized.actionTitle.toLowerCase();
    }

    function flash() {
        glowFade.stop();
        glow = 1;
        glowFade.start();
    }
    NumberAnimation { id: glowFade; target: overviewPage; property: "glow"; to: 0; duration: 1150; easing.type: Easing.OutQuad }
    onDialingChanged: {
        if (dialing) wristTurn = 0;
        else flash();
    }

    Connections {
        target: daemon
        function onGesture(gesture) {
            overviewPage.recognized = gesture;
            hand.play(gesture);
            overviewPage.flash();
        }
        // The mirror follows the wrist itself, not the steps sent to the desktop. Those are rate
        // limited, and a quick turn would hardly move the light at all.
        function onDial(delta) {
            if (isFinite(delta)) overviewPage.wristTurn = Math.max(-60, Math.min(60, overviewPage.wristTurn + delta));
        }
    }

    ColumnLayout {
        width: overviewPage.availableWidth
        spacing: Kirigami.Units.largeSpacing

        // The hand floats on the page with no box: its ring and its caption sit around it.
        Item {
            Layout.fillWidth: true
            Layout.preferredHeight: Kirigami.Units.gridUnit * 18
            Layout.topMargin: Kirigami.Units.largeSpacing

            ColumnLayout {
                anchors.left: parent.left
                anchors.leftMargin: Kirigami.Units.largeSpacing * 2
                anchors.right: stage.left
                anchors.verticalCenter: parent.verticalCenter
                spacing: Kirigami.Units.smallSpacing

                QQC2.Label {
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                    textFormat: Text.StyledText
                    font.pointSize: Kirigami.Theme.defaultFont.pointSize * 2
                    font.weight: Font.Light
                    color: Kirigami.Theme.disabledTextColor
                    text: overviewPage.words[0] + "<font color=\"" + Kirigami.Theme.textColor + "\"><b>"
                        + overviewPage.words[1] + "</b></font>" + overviewPage.words[2]
                }
                QQC2.Label {
                    readonly property bool assigned: overviewPage.outcome !== "unassigned"
                    visible: overviewPage.outcome !== ""
                    text: "↳ " + (overviewPage.ctl.controlsEnabled ? "" : "paused · ") + overviewPage.outcome
                    color: overviewPage.ctl.controlsEnabled && assigned ? Kirigami.Theme.highlightColor : Kirigami.Theme.disabledTextColor
                    opacity: 0.5 + 0.5 * (overviewPage.dialing ? 1 : overviewPage.glow)
                }
            }

            Item {
                id: stage
                anchors.right: parent.right
                anchors.rightMargin: Kirigami.Units.largeSpacing * 2
                anchors.verticalCenter: parent.verticalCenter
                width: Math.min(parent.height, parent.width * 0.6)
                height: width

                // White on white needs no more light. On a dark page the hand gets a pool of its own.
                Canvas {
                    anchors.fill: parent
                    anchors.margins: -Kirigami.Units.largeSpacing
                    visible: Kirigami.Theme.backgroundColor.hslLightness < 0.5
                    onPaint: {
                        const ctx = getContext("2d");
                        ctx.reset();
                        const r = width / 2;
                        const pool = ctx.createRadialGradient(r, r, r * 0.16, r, r, r);
                        pool.addColorStop(0, Qt.rgba(0.75, 0.88, 1.0, 0.085));
                        pool.addColorStop(1, Qt.rgba(0.75, 0.88, 1.0, 0));
                        ctx.fillStyle = pool;
                        ctx.fillRect(0, 0, width, height);
                    }
                }
                HandView {
                    id: hand
                    anchors.fill: parent
                    hand: overviewPage.ctl.bandHand === "left" ? "left" : "right"
                    highlight: overviewPage.highlight
                    sustained: !!overviewPage.ctl.pinchedFinger || overviewPage.ctl.dialEngaged === true
                    roll: overviewPage.ctl.dialEngaged ? overviewPage.wristTurn : 0
                }
                // The electrodes sit on top of the hand's view, so its square never hides them.
                ElectrodeRing {
                    anchors.fill: parent
                    angle: overviewPage.wristTurn * overviewPage.ringGain
                    engaged: overviewPage.dialing ? 1 : 0
                }
            }
        }

        FormCard.FormHeader { title: "Your gestures" }
        GestureSummary {}

        QQC2.Label {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.largeSpacing * 2
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            opacity: 0.6
            text: "Close this window: Kinesis stays in your system tray."
        }
    }
}
