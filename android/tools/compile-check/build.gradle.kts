import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins { id("org.jetbrains.kotlin.jvm") version "2.0.21" }

kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
sourceSets { main { kotlin.srcDir("../../app/src/main/kotlin") } }

dependencies {
    compileOnly("org.robolectric:android-all:15-robolectric-13954326") // API 35
    implementation(project(":core"))
}
