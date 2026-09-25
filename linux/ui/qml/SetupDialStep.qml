// Setup step 3: practice pinch + turn on a dial that follows the band. Controls are paused.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

ColumnLayout {
    id: step

    readonly property var ctl: daemon.state.controller || ({})
    property real angle: 0
    property real travelled: 0
    readonly property bool completed: travelled >= 90

    Connections {
        target: daemon
        function onDial(delta) {
            step.angle += delta;
            step.travelled += Math.abs(delta);
        }
    }

    spacing: Kirigami.Units.largeSpacing * 2

    Item { Layout.fillHeight: true }

    Kirigami.Heading {
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignHCenter
        level: 1
        text: "Pinch and turn your wrist."
    }
    QQC2.Label {
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.Wrap
        text: step.completed ? "Got it. You're getting the hang of this."
            : !step.ctl.live ? "Pair your band to try the dial."
            : step.ctl.dialEngaged ? "Keep holding the pinch as you turn."
            : "Pinch your index finger and thumb, then turn your wrist like a knob. Controls are paused, so practice won't change anything."
    }

    PracticeDial {
        Layout.alignment: Qt.AlignHCenter
        angle: step.angle
        engaged: step.ctl.dialEngaged === true
    }

    Item { Layout.fillHeight: true }
}
