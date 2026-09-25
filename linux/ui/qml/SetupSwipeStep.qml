// Setup step 2: try each swipe; each direction ticks off as the band reports it. Until the band
// sends something, the hand acts out the swipe you pick; after that it mirrors the band.

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
    property string preview: "left"
    property bool received: false
    property string handHighlight: "index"

    function demonstrate(direction) {
        preview = direction;
        handHighlight = "index";
        hand.play({ kind: "swipe", key: "swipe:" + direction });
    }

    // The hand acts out its swipe the moment the step appears.
    StackLayout.onIsCurrentItemChanged: if (StackLayout.isCurrentItem && !received) demonstrate(preview)

    Connections {
        target: daemon
        function onGesture(gesture) {
            step.received = true;
            step.handHighlight = gesture.key.startsWith("tap:middle") ? "middle" : "index";
            hand.play(gesture);
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

    Item {
        Layout.alignment: Qt.AlignHCenter
        implicitWidth: Kirigami.Units.gridUnit * 15
        implicitHeight: implicitWidth

        HandView {
            id: hand
            anchors.fill: parent
            margin: 0.7
            hand: step.ctl.bandHand === "left" ? "left" : "right"
            highlight: step.ctl.pinchedFinger ? (step.ctl.pinchedFinger === "middle" ? "middle" : "index") : step.handHighlight
            sustained: !!step.ctl.pinchedFinger
        }
        ElectrodeRing { anchors.fill: parent }
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
                showClickFeedback: true
                highlighted: !step.received && step.preview === modelData.id
                onClicked: step.demonstrate(modelData.id)
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
