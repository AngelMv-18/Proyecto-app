// Verificación sin SDK de Android: compila las fuentes de :app contra las clases del framework (Robolectric android-all).
// Uso: cd android/tools/compile-check && gradle compileKotlin
pluginManagement { repositories { mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { mavenCentral() } }
rootProject.name = "compile-check"
include(":core")
project(":core").projectDir = file("../../core")
