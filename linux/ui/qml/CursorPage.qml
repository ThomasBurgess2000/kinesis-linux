// Cursor (developer mode): the experimental air cursor. Move your forearm to move the pointer,
// pinch your index to click and hold to drag, pinch your middle finger to right-click. Port of the
// Mac app's CursorPage: the hand mirrors the forearm, and three levers tune the feel.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import QtQuick.Window
import org.kde.kirigami as Kirigami
import org.kde.kirigamiaddons.formcard as FormCard

QQC2.ScrollView {
    id: cursorPage

    readonly property var ctl: daemon.state.controller || ({})
    readonly property var cursor: ctl.airCursor || ({})
    readonly property var levers: daemon.config.cursor || ({ speed: 45, flickBoost: 1.6, steadiness: 0.5 })
    readonly property var standard: ({ speed: 45, flickBoost: 1.6, steadiness: 0.5 })
    readonly property bool leversChanged: levers.speed !== standard.speed
        || Math.abs(levers.flickBoost - standard.flickBoost) > 0.01 || Math.abs(levers.steadiness - standard.steadiness) > 0.01

    readonly property string status: {
        if (cursor.repositioning) return "Parked · let go of Alt";
        if (cursor.enabled) return "Pinch to click · hold to drag · middle pinch to right-click" + (cursor.keys ? " · Esc to stop" : "");
        if (!cursor.available) return "Connect your band and turn on controls.";
        return "Move your forearm to move the pointer, like a mouse.";
    }

    /// Degrees a second: how fast the arm turns, from the daemon's motion updates.
    property real armSpeed: 0
    /// The forearm's aim, and a rest that follows it over a few seconds, so the hand turns with a
    /// move and drifts back to the middle when held.
    property var aim: null
    property var rest: null

    function remainder(x, y) {
        return x - y * Math.round(x / y);
    }
    function clamp(value, low, high) {
        return Math.max(low, Math.min(high, value));
    }

    Connections {
        target: daemon
        function onMotion(data) {
            cursorPage.armSpeed = data.armSpeed || 0;
            const aim = data.aim;
            if (!aim) return;
            cursorPage.aim = aim;
            if (!cursorPage.rest) {
                cursorPage.rest = { azimuth: aim.azimuth, elevation: aim.elevation };
                return;
            }
            // About 20 updates a second: rest follows the arm over about 2.5 seconds.
            cursorPage.rest = {
                azimuth: cursorPage.rest.azimuth + cursorPage.remainder(aim.azimuth - cursorPage.rest.azimuth, 360) * 0.02,
                elevation: cursorPage.rest.elevation + (aim.elevation - cursorPage.rest.elevation) * 0.02,
            };
        }
    }

    ColumnLayout {
        width: cursorPage.availableWidth
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: "A little room to move."; level: 1; Layout.fillWidth: true }
            QQC2.Label { text: "Developer"; opacity: 0.6 }
        }

        FormCard.FormCard {
            FormCard.FormSwitchDelegate {
                text: "Air cursor"
                description: "Experimental. " + cursorPage.status
                checked: cursorPage.cursor.enabled === true
                enabled: cursorPage.cursor.enabled === true || cursorPage.cursor.available === true
                onToggled: {
                    daemon.setAirCursor(checked);
                    checked = Qt.binding(() => cursorPage.cursor.enabled === true);
                }
            }
        }

        Kirigami.InlineMessage {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.largeSpacing
            type: Kirigami.MessageType.Warning
            visible: !!cursorPage.cursor.error
            text: cursorPage.cursor.error || ""
        }
        Kirigami.InlineMessage {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.largeSpacing
            type: Kirigami.MessageType.Information
            visible: cursorPage.cursor.enabled === true && cursorPage.cursor.keys !== true
            text: "Escape and Alt can't be read from your keyboard, so turn the cursor off here or from the tray. Joining the input group fixes this."
        }

        // The hand turns as the forearm turns and pinches as the fingers pinch, so you see what the
        // band reads: where the forearm points.
        Item {
            Layout.alignment: Qt.AlignHCenter
            Layout.topMargin: Kirigami.Units.largeSpacing
            implicitWidth: Kirigami.Units.gridUnit * 14
            implicitHeight: Kirigami.Units.gridUnit * 11

            HandView {
                anchors.fill: parent
                hand: cursorPage.ctl.bandHand === "left" ? "left" : "right"
                highlight: cursorPage.ctl.pinchedFinger ? (cursorPage.ctl.pinchedFinger === "middle" ? "middle" : "index") : "none"
                sustained: !!cursorPage.ctl.pinchedFinger
                aimLeft: cursorPage.aim && cursorPage.rest
                    ? cursorPage.clamp(cursorPage.remainder(cursorPage.aim.azimuth - cursorPage.rest.azimuth, 360), -40, 40) : 0
                aimUp: cursorPage.aim && cursorPage.rest
                    ? cursorPage.clamp(cursorPage.aim.elevation - cursorPage.rest.elevation, -40, 40) : 0
            }
        }

        FormCard.FormHeader { title: "Feel" }
        FormCard.FormCard {
            CursorLever {
                title: "Speed"
                value: Math.round(Screen.width / cursorPage.levers.speed) + "° across this screen"
                lower: "Slower"
                higher: "Faster"
                from: 20; to: 100; stepSize: 5
                setting: cursorPage.levers.speed
                modified: cursorPage.levers.speed !== cursorPage.standard.speed
                onCommit: (v) => daemon.setConfig({ cursor: { speed: v } })
                onReset: daemon.setConfig({ cursor: { speed: cursorPage.standard.speed } })
            }
            FormCard.FormDelegateSeparator {}
            CursorLever {
                title: "Flick boost"
                value: cursorPage.levers.flickBoost.toFixed(1) + "×"
                lower: "Even"
                higher: "More boost"
                from: 1; to: 2.5; stepSize: 0.1
                setting: cursorPage.levers.flickBoost
                modified: Math.abs(cursorPage.levers.flickBoost - cursorPage.standard.flickBoost) > 0.01
                onCommit: (v) => daemon.setConfig({ cursor: { flickBoost: Math.round(v * 10) / 10 } })
                onReset: daemon.setConfig({ cursor: { flickBoost: cursorPage.standard.flickBoost } })
            }
            FormCard.FormDelegateSeparator {}
            CursorLever {
                title: "Steadiness"
                value: ""
                lower: "More responsive"
                higher: "More steady"
                from: 0; to: 1; stepSize: 0.1
                setting: cursorPage.levers.steadiness
                modified: Math.abs(cursorPage.levers.steadiness - cursorPage.standard.steadiness) > 0.01
                onCommit: (v) => daemon.setConfig({ cursor: { steadiness: Math.round(v * 10) / 10 } })
                onReset: daemon.setConfig({ cursor: { steadiness: cursorPage.standard.steadiness } })
                // Inside the ring, the pointer holds still.
                side: StillnessRing {
                    speed: cursorPage.armSpeed
                    steadiness: cursorPage.levers.steadiness
                    live: cursorPage.ctl.live === true
                }
            }
        }

        FormCard.FormHeader { title: "Try it" }
        FormCard.FormCard {
            FormCard.AbstractFormDelegate {
                background: null
                contentItem: Flow {
                    spacing: Kirigami.Units.smallSpacing
                    Repeater {
                        model: [["click", "Click"], ["rightClick", "Right-click"], ["drag", "Drag"], ["doubleClick", "Double-click"]]
                        // A chip, not a control: it lights up once you've done it with the cursor.
                        delegate: Rectangle {
                            required property var modelData
                            readonly property bool done: (cursorPage.cursor.skills || []).includes(modelData[0])
                            implicitWidth: chip.implicitWidth + Kirigami.Units.largeSpacing * 2
                            implicitHeight: chip.implicitHeight + Kirigami.Units.smallSpacing * 2
                            radius: height / 2
                            color: done ? Kirigami.Theme.highlightColor : Kirigami.Theme.alternateBackgroundColor
                            Behavior on color { ColorAnimation { duration: 200 } }
                            QQC2.Label {
                                id: chip
                                anchors.centerIn: parent
                                text: (parent.done ? "✓ " : "") + parent.modelData[1]
                                color: parent.done ? Kirigami.Theme.highlightedTextColor : Kirigami.Theme.textColor
                            }
                        }
                    }
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.largeSpacing * 2
            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                opacity: 0.6
                text: "Hold Alt to move your arm without moving the pointer."
            }
            QQC2.Button {
                visible: cursorPage.leversChanged
                text: "Reset all"
                icon.name: "edit-undo"
                onClicked: daemon.setConfig({ cursor: cursorPage.standard })
            }
        }
    }
}
