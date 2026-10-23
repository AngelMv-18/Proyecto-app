pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
    // Versiones centralizadas; cada plugin se descarga solo si un módulo lo aplica.
    plugins {
        id("com.android.application") version "8.7.3"
        id("org.jetbrains.kotlin.android") version "2.0.21"
        id("org.jetbrains.kotlin.jvm") version "2.0.21"
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "nova-capture"
include(":core")
// El módulo Android necesita el SDK de Android (ANDROID_HOME o local.properties). Sin él solo se compila y prueba :core.
if (System.getenv("ANDROID_HOME") != null || System.getenv("ANDROID_SDK_ROOT") != null || file("local.properties").exists()) {
    include(":app")
}
