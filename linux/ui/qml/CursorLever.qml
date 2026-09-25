// One air cursor setting: its name, its value, a slider, and what each end means. The setting is
// written when the slider is let go, not on every step of a drag.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.kirigamiaddons.formcard as FormCard

FormCard.AbstractFormDelegate {
    id: lever

    property string title
    property string value
    property string lower
    property string higher
    property real from
    property real to
    property real stepSize
    /// The saved value; the slider follows it except while it's being dragged.
    property real setting
    property bool modified: false
    /// Something shown beside the lever, such as the stillness ring.
    property alias side: sideSlot.data

    signal commit(real value)
    signal reset()

    background: null
    contentItem: RowLayout {
        spacing: Kirigami.Units.largeSpacing * 2

        ColumnLayout {
            Layout.fillWidth: true
            spacing: Kirigami.Units.smallSpacing

            RowLayout {
                QQC2.Label { text: lever.title }
                QQC2.Button {
                    visible: lever.modified
                    text: "Reset"
                    flat: true
                    display: QQC2.AbstractButton.TextOnly
                    onClicked: lever.reset()
                }
                Item { Layout.fillWidth: true }
                QQC2.Label { text: lever.value; opacity: 0.7; font.features: { "tnum": 1 } }
            }
            QQC2.Slider {
                Layout.fillWidth: true
                from: lever.from
                to: lever.to
                stepSize: lever.stepSize
                snapMode: QQC2.Slider.SnapAlways
                value: lever.setting
                onPressedChanged: if (!pressed) send()
                // Keyboard steps have no press to end.
                onMoved: if (!pressed) send()
                function send() {
                    if (Math.abs(value - lever.setting) > 1e-6) lever.commit(value);
                    value = Qt.binding(() => lever.setting);
                }
            }
            RowLayout {
                QQC2.Label { text: lever.lower; opacity: 0.6; font: Kirigami.Theme.smallFont; Layout.fillWidth: true }
                QQC2.Label { text: lever.higher; opacity: 0.6; font: Kirigami.Theme.smallFont }
            }
        }

        Item {
            id: sideSlot
            visible: children.length > 0
            implicitWidth: childrenRect.width
            implicitHeight: childrenRect.height
        }
    }
}
