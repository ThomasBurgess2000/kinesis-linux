// The arm's live speed as a disk, and the stillness threshold as a ring. While the disk stays
// inside the ring, the pointer holds still. Steadiness grows the ring. Port of upstream's
// StillnessRing.

import QtQuick
import org.kde.kirigami as Kirigami

Item {
    id: ring

    /// Degrees a second the arm is turning.
    property real speed: 0
    property real steadiness: 0.5
    property bool live: false
    /// Below this the arm counts as held still (AirPointer.still).
    readonly property real stillBelow: 0.5 + 0.7 * Math.max(0, Math.min(1, steadiness))
    readonly property bool moving: speed > stillBelow
    /// Degrees a second at the edge of the drawing.
    readonly property real scale: 3

    function diameter(degrees) {
        return Math.min(1, degrees / scale) * (width - 6);
    }

    implicitWidth: Kirigami.Units.gridUnit * 5
    implicitHeight: implicitWidth

    Rectangle {
        anchors.centerIn: parent
        width: parent.width - 6
        height: width
        radius: width / 2
        color: "transparent"
        border.width: 1
        border.color: Qt.alpha(Kirigami.Theme.textColor, 0.15)
    }
    Rectangle {
        anchors.centerIn: parent
        visible: ring.live
        width: Math.max(6, ring.diameter(ring.speed))
        height: width
        radius: width / 2
        color: ring.moving ? Qt.alpha(Kirigami.Theme.textColor, 0.18) : Qt.alpha(Kirigami.Theme.highlightColor, 0.22)
        Behavior on width { NumberAnimation { duration: 120; easing.type: Easing.OutQuad } }
    }
    Rectangle {
        anchors.centerIn: parent
        width: ring.diameter(ring.stillBelow)
        height: width
        radius: width / 2
        color: "transparent"
        border.width: 1.5
        border.color: Qt.alpha(Kirigami.Theme.highlightColor, 0.8)
        Behavior on width { NumberAnimation { duration: 250; easing.type: Easing.OutCubic } }
    }
}
