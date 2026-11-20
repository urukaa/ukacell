import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 37
    namespace = "dev.ukacell.host"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "dev.ukacell.host"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))

// >>> ukacell: release signing & cleartext (managed by scripts/patch-android.mjs)
val ukacellKeystoreFile = rootProject.file("keystore.properties")
if (ukacellKeystoreFile.exists()) {
    val ukacellKeystore = Properties().apply {
        ukacellKeystoreFile.inputStream().use { load(it) }
    }
    android {
        signingConfigs {
            create("ukacellRelease") {
                keyAlias = ukacellKeystore.getProperty("keyAlias")
                keyPassword = ukacellKeystore.getProperty("password")
                storeFile = file(ukacellKeystore.getProperty("storeFile"))
                storePassword = ukacellKeystore.getProperty("password")
            }
        }
        buildTypes {
            getByName("release") {
                signingConfig = signingConfigs.getByName("ukacellRelease")
            }
        }
    }
} else {
    logger.warn("ukacell: gen/android/keystore.properties not found, the release APK will be unsigned")
}
android {
    buildTypes {
        getByName("release") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
    }
}
// <<< ukacell
