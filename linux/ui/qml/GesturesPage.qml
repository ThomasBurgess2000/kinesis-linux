// Gestures: what each swipe, tap, and the pinch dial does. Rows light up when their gesture fires.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.kirigamiaddons.formcard as FormCard

QQC2.ScrollView {
    id: gesturesPage

    readonly property var config: daemon.config
    // Actions the current backend can perform ("No action" first).
    readonly property var actions: (daemon.catalog.actions || [])
        .filter((a) => a.supported)
        .map((a) => ({ id: a.id, title: applicationWindow().actionTitle(a.id) }))
    property string firing: ""

    function assign(group, gesture, action) {
        const patch = {};
        patch[group] = {};
        patch[group][gesture] = action;
        daemon.setConfig(patch);
    }

    Connections {
        target: daemon
        function onGesture(gesture) {
            gesturesPage.firing = gesture.key;
            unlight.restart();
        }
    }
    Timer { id: unlight; interval: 900; onTriggered: gesturesPage.firing = "" }

    ColumnLayout {
        width: gesturesPage.availableWidth
        spacing: 0

        QQC2.TabBar {
            id: kind
            Layout.alignment: Qt.AlignHCenter
            Layout.topMargin: Kirigami.Units.largeSpacing
            QQC2.TabButton { text: "Swipe"; width: implicitWidth }
            QQC2.TabButton { text: "Tap"; width: implicitWidth }
            QQC2.TabButton { text: "Turn"; width: implicitWidth }
        }

        StackLayout {
            Layout.fillWidth: true
            currentIndex: kind.currentIndex

            FormCard.FormCard {
                Layout.topMargin: Kirigami.Units.largeSpacing
                Repeater {
                    model: daemon.catalog.swipes || []
                    delegate: ChoiceDelegate {
                        required property var modelData
                        text: modelData.title
                        highlighted: gesturesPage.firing === "swipe:" + modelData.id
                        options: gesturesPage.actions
                        selectedId: (gesturesPage.config.swipes || {})[modelData.id] || "none"
                        onChosen: (id) => gesturesPage.assign("swipes", modelData.id, id)
                    }
                }
            }

            FormCard.FormCard {
                Layout.topMargin: Kirigami.Units.largeSpacing
                Repeater {
                    model: daemon.catalog.taps || []
                    delegate: ChoiceDelegate {
                        required property var modelData
                        text: modelData.title
                        highlighted: gesturesPage.firing === "tap:" + modelData.id
                        options: gesturesPage.actions
                        selectedId: (gesturesPage.config.taps || {})[modelData.id] || "none"
                        onChosen: (id) => gesturesPage.assign("taps", modelData.id, id)
                    }
                }
            }

            ColumnLayout {
                spacing: 0
                FormCard.FormCard {
                    Layout.topMargin: Kirigami.Units.largeSpacing
                    ChoiceDelegate {
                        text: "Pinch + turn"
                        description: "Pinch your index finger and thumb, then turn your wrist like a knob."
                        options: daemon.catalog.dialTargets || []
                        selectedId: (gesturesPage.config.dial || {}).target || "none"
                        onChosen: (id) => daemon.setConfig({ dial: { target: id } })
                    }
                    FormCard.FormDelegateSeparator {}
                    FormCard.AbstractFormDelegate {
                        background: null
                        contentItem: ColumnLayout {
                            RowLayout {
                                QQC2.Label { text: "Sensitivity"; Layout.fillWidth: true }
                                QQC2.Label { text: sensitivity.value.toFixed(2) + "×"; opacity: 0.7 }
                            }
                            QQC2.Slider {
                                id: sensitivity
                                Layout.fillWidth: true
                                from: 0.5
                                to: 4
                                stepSize: 0.25
                                snapMode: QQC2.Slider.SnapAlways
                                value: (gesturesPage.config.dial || {}).sensitivity || 1
                                onMoved: save.restart()
                            }
                            RowLayout {
                                QQC2.Label { text: "More precise"; opacity: 0.6; Layout.fillWidth: true }
                                QQC2.Label { text: "Less movement"; opacity: 0.6 }
                            }
                            Timer {
                                id: save
                                interval: 300
                                onTriggered: daemon.setConfig({ dial: { sensitivity: sensitivity.value } })
                            }
                        }
                    }
                }
            }
        }
    }
}
