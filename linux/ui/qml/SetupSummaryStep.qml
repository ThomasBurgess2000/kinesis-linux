// Setup step 4: what your gestures do, and a check that desktop actions work here.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.kirigamiaddons.formcard as FormCard

QQC2.ScrollView {
    id: step

    readonly property var actionChecks: (daemon.doctor || []).filter((row) => row.name === "KDE backend" || row.name === "ydotool")

    Component.onCompleted: daemon.refreshDoctor()

    ColumnLayout {
        width: step.availableWidth
        spacing: Kirigami.Units.largeSpacing

        Kirigami.Heading {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            level: 1
            text: "Take it from here."
        }
        QQC2.Label {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            opacity: 0.8
            text: "Here's what your gestures do. You can change them any time under Gestures."
        }

        GestureSummary {}

        FormCard.FormHeader { title: "Desktop actions" }
        FormCard.FormCard {
            Repeater {
                model: step.actionChecks
                delegate: FormCard.FormTextDelegate {
                    required property var modelData
                    text: modelData.name
                    description: modelData.detail
                    leading: Kirigami.Icon {
                        implicitWidth: Kirigami.Units.iconSizes.small
                        implicitHeight: Kirigami.Units.iconSizes.small
                        source: modelData.ok ? "emblem-ok-symbolic" : "emblem-warning"
                    }
                }
            }
            FormCard.FormComboBoxDelegate {
                id: testAction
                text: "Test an action"
                description: "Sends it once, so you can see it work."
                model: (daemon.catalog.actions || []).filter((a) => a.supported && a.id !== "none")
                textRole: "title"
                valueRole: "id"
            }
            FormCard.FormButtonDelegate {
                icon.name: "media-playback-start"
                text: "Send it"
                enabled: testAction.currentValue !== undefined
                onClicked: daemon.testAction(testAction.currentValue)
            }
        }
    }
}
