import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun quotedBuildConfigString(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val danmakuServerUrl = providers.gradleProperty("danmakuServerUrl")
    .orElse(providers.environmentVariable("DANMAKU_SERVER_URL"))
    .orElse("https://example.invalid")
    .get()
    .trim()

val danmakuServerUri = runCatching { URI(danmakuServerUrl) }
    .getOrElse { throw GradleException("DANMAKU_SERVER_URL must be an absolute HTTP(S) URL", it) }
val danmakuServerHost = danmakuServerUri.host?.lowercase()
    ?: throw GradleException("DANMAKU_SERVER_URL must include a host")
require(danmakuServerUri.scheme == "https") { "DANMAKU_SERVER_URL must use HTTPS" }
require(danmakuServerUri.userInfo == null) { "DANMAKU_SERVER_URL must not contain credentials" }
require(danmakuServerUri.rawQuery == null && danmakuServerUri.rawFragment == null) {
    "DANMAKU_SERVER_URL must not contain a query or fragment"
}
require(danmakuServerUri.path.isNullOrEmpty() || danmakuServerUri.path == "/") {
    "DANMAKU_SERVER_URL must not contain a path"
}

val releaseSigningValues = listOf(
    "DANMAKU_RELEASE_STORE_FILE",
    "DANMAKU_RELEASE_STORE_PASSWORD",
    "DANMAKU_RELEASE_KEY_ALIAS",
    "DANMAKU_RELEASE_KEY_PASSWORD",
).associateWith { name ->
    providers.environmentVariable(name).orNull?.takeIf { it.isNotBlank() }
}
val releaseSigningConfigured = releaseSigningValues.values.all { !it.isNullOrBlank() }

android {
    namespace = "com.kolvid.danmaku"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.kolvid.danmaku"
        minSdk = 26
        targetSdk = 34
        versionCode = 4
        versionName = "0.1.3"
        buildConfigField("String", "DANMAKU_SERVER_URL", quotedBuildConfigString(danmakuServerUrl))
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            val releaseSigningStoreFile = requireNotNull(releaseSigningValues["DANMAKU_RELEASE_STORE_FILE"])
            val releaseSigningStorePassword = requireNotNull(releaseSigningValues["DANMAKU_RELEASE_STORE_PASSWORD"])
            val releaseSigningKeyAlias = requireNotNull(releaseSigningValues["DANMAKU_RELEASE_KEY_ALIAS"])
            val releaseSigningKeyPassword = requireNotNull(releaseSigningValues["DANMAKU_RELEASE_KEY_PASSWORD"])
            create("release") {
                storeFile = file(releaseSigningStoreFile)
                storePassword = releaseSigningStorePassword
                keyAlias = releaseSigningKeyAlias
                keyPassword = releaseSigningKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseSigningConfigured) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("io.socket:socket.io-client:2.1.0")
    implementation("org.json:json:20240303")

    testImplementation("junit:junit:4.13.2")
}
