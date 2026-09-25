// Band: wrist, startup, the Meta account, diagnostics, and forgetting the band.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.kirigamiaddons.formcard as FormCard

QQC2.ScrollView {
    id: bandPage

    readonly property var st: daemon.state
    readonly property var ctl: st.controller || ({})

    Component.onCompleted: daemon.refreshDoctor()

    Kirigami.PromptDialog {
        id: confirmForget
        title: "Forget this band?"
        subtitle: "This removes the band, its key, and your Meta sign-in from this computer. The band stays claimed to your Meta account until you factory reset it."
        standardButtons: Kirigami.Dialog.NoButton
        customFooterActions: [
            Kirigami.Action {
                text: "Forget band"
                icon.name: "edit-delete"
                onTriggered: {
                    confirmForget.close();
                    daemon.forget();
                    applicationWindow().showFactoryReset();
                }
            },
            Kirigami.Action { text: "Cancel"; onTriggered: confirmForget.close() }
        ]
    }

    ColumnLayout {
        width: bandPage.availableWidth
        spacing: 0

        FormCard.FormHeader { title: "Band" }
        FormCard.FormCard {
            FormCard.FormRadioDelegate {
                text: "Left wrist"
                checked: bandPage.ctl.bandHand === "left"
                enabled: bandPage.st.canChangeHand === true
                onToggled: if (checked) daemon.selectHand("left")
            }
            FormCard.FormRadioDelegate {
                text: "Right wrist"
                checked: bandPage.ctl.bandHand !== "left"
                enabled: bandPage.st.canChangeHand === true
                onToggled: if (checked) daemon.selectHand("right")
            }
            FormCard.FormTextDelegate {
                text: bandPage.ctl.pendingHand ? "Switching to your " + bandPage.ctl.pendingHand + " wrist…"
                    : bandPage.ctl.handSettingError ? bandPage.ctl.handSettingError
                    : bandPage.ctl.handConfirmed ? "Confirmed by your band" : "Connect your band to change this"
                textItem.opacity: 0.7
            }
        }

        FormCard.FormHeader { title: "This computer" }
        FormCard.FormCard {
            FormCard.FormSwitchDelegate {
                text: "Start automatically"
                description: "Connect your band and enable controls when Kinesis starts."
                checked: daemon.config.startAutomatically !== false
                onToggled: daemon.setConfig({ startAutomatically: checked })
            }
            FormCard.FormDelegateSeparator {}
            FormCard.FormSwitchDelegate {
                text: "Start at login"
                description: "Run Kinesis in the background and show it in the system tray when you log in."
                checked: daemon.startAtLogin
                onToggled: daemon.setStartAtLogin(checked)
            }
        }

        FormCard.FormHeader { title: "Meta account" }
        FormCard.FormCard {
            FormCard.FormTextDelegate {
                text: bandPage.st.metaUser ? "Signed in" : "Not signed in"
                description: bandPage.st.metaUser
                    ? "Meta user " + bandPage.st.metaUser + ". Only needed to pair a band again."
                    : "You'll sign in once when you pair a band."
            }
            FormCard.FormButtonDelegate {
                visible: !!bandPage.st.metaUser
                icon.name: "system-log-out"
                text: "Sign out"
                onClicked: daemon.signOut()
            }
        }

        FormCard.FormHeader { title: "Diagnostics" }
        FormCard.FormCard {
            Repeater {
                model: daemon.doctor
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
            FormCard.FormButtonDelegate {
                icon.name: "view-refresh"
                text: "Check again"
                onClicked: daemon.refreshDoctor()
            }
            FormCard.FormDelegateSeparator {}
            FormCard.FormComboBoxDelegate {
                id: testAction
                text: "Test an action"
                description: "Sends it once, as if you'd made the gesture."
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

        FormCard.FormCard {
            Layout.topMargin: Kirigami.Units.gridUnit
            Layout.bottomMargin: Kirigami.Units.gridUnit
            FormCard.FormButtonDelegate {
                icon.name: "edit-delete"
                text: "Forget this band"
                description: "Removes the band, its key, and your Meta sign-in from this computer."
                onClicked: confirmForget.open()
            }
        }
    }
}
