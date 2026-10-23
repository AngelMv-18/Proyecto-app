plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "hn.nova.capture"
    compileSdk = 35
    defaultConfig {
        applicationId = "hn.nova.capture"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            // Se firma con la clave de depuración para poder instalarlo directamente (sideload). Para distribuir, usa tu propia clave.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    lint { abortOnError = false; checkReleaseBuilds = true }
}

dependencies {
    // Sin librerías de terceros: solo la lógica compartida (probada en JVM) y las APIs del sistema Android.
    implementation(project(":core"))
}
