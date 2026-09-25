// A knob whose pointer follows the band's wrist rotation (degrees, relative).

import QtQuick
import org.kde.kirigami as Kirigami

Item {
    id: dial

    property real angle: 0
    property bool engaged: false

    implicitWidth: Kirigami.Units.gridUnit * 10
    implicitHeight: implicitWidth

    Rectangle {
        anchors.fill: parent
        radius: width / 2
        color: Kirigami.Theme.alternateBackgroundColor
        border.width: 3
        border.color: dial.engaged ? Kirigami.Theme.highlightColor : Kirigami.Theme.disabledTextColor
        Behavior on border.color { ColorAnimation { duration: 150 } }
    }

    Item {
        anchors.fill: parent
        rotation: dial.angle
        Behavior on rotation { SmoothedAnimation { velocity: 540 } }

        Rectangle {
            width: 5
            height: dial.height / 2 - Kirigami.Units.largeSpacing * 2
            radius: width / 2
            x: (dial.width - width) / 2
            y: Kirigami.Units.largeSpacing * 2
            color: Kirigami.Theme.highlightColor
        }
    }

    Rectangle {
        anchors.centerIn: parent
        width: Kirigami.Units.gridUnit
        height: width
        radius: width / 2
        color: Kirigami.Theme.highlightColor
    }
}
