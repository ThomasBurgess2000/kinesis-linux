// Setup step 2: try each swipe; each direction ticks off as the band reports it.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

ColumnLayout {
    id: step

    readonly property var ctl: daemon.state.controller || ({})
    property var seen: ({})
    readonly property int count: Object.keys(seen).length
    readonly property var icons: ({ left: "go-previous", right: "go-next", up: "go-up", down: "go-down" })

    Connections {
        target: daemon
        function onGesture(gesture) {
            if (gesture.kind !== "swipe") return;
            const next = Object.assign({}, step.seen);
            next[gesture.key] = true;
            step.seen = next;
        }
    }

    spacing: Kirigami.Units.largeSpacing * 2

    Item { Layout.fillHeight: true }

    Kirigami.Heading {
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignHCenter
        level: 1
        text: "Swipe with your thumb."
    }
    QQC2.Label {
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.Wrap
        text: step.ctl.live
            ? "Slide your thumb along the side of your index finger: left, right, up, or down."
            : "Pair your band to try swiping."
    }

    RowLayout {
        Layout.alignment: Qt.AlignHCenter
        spacing: Kirigami.Units.largeSpacing
        Repeater {
            model: daemon.catalog.swipes || []
            delegate: Kirigami.AbstractCard {
                required property var modelData
                readonly property bool done: !!step.seen["swipe:" + modelData.id]
                implicitWidth: Kirigami.Units.gridUnit * 8
                contentItem: ColumnLayout {
                    Kirigami.Icon {
                        Layout.alignment: Qt.AlignHCenter
                        implicitWidth: Kirigami.Units.iconSizes.large
                        implicitHeight: Kirigami.Units.iconSizes.large
                        source: done ? "emblem-ok-symbolic" : step.icons[modelData.id]
                        color: done ? Kirigami.Theme.positiveTextColor : Kirigami.Theme.textColor
                    }
                    QQC2.Label { Layout.alignment: Qt.AlignHCenter; text: modelData.title; font.bold: true }
                    QQC2.Label {
                        Layout.alignment: Qt.AlignHCenter
                        text: applicationWindow().actionTitle((daemon.config.swipes || {})[modelData.id])
                        opacity: 0.7
                    }
                }
            }
        }
    }

    QQC2.Label {
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignHCenter
        opacity: 0.7
        text: step.count >= 4 ? "Nice. That's all four." : step.count > 0 ? step.count + " of 4 tried" : ""
    }

    Item { Layout.fillHeight: true }
}
