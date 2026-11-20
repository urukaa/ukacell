buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

// >>> ukacell: minimum plugin compileSdk (managed by scripts/patch-android.mjs)
// Some community plugins (e.g. tauri-plugin-torch) pin a compileSdk below the
// 36 that :tauri-android requires; raise them to the app's compileSdk.
subprojects {
    plugins.withId("com.android.library") {
        extensions.configure<com.android.build.api.variant.LibraryAndroidComponentsExtension> {
            finalizeDsl {
                val current = it.compileSdk ?: 0
                if (current < 36) {
                    it.compileSdk = 37
                    logger.lifecycle("ukacell: ${project.path} compileSdk $current -> 37")
                }
            }
        }
    }
}
// <<< ukacell
