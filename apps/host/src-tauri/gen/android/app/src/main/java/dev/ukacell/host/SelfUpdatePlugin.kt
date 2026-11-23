package dev.ukacell.host

// In-app updates, called through src-tauri/src/self_update.rs.
// Downloads a release APK, checks its SHA-256 against the published .sha256
// file and that it is a newer build of this app, then opens the Android
// installer. Android itself rejects APKs signed with a different key.

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

@InvokeArg
class InstallArgs {
  lateinit var url: String
  lateinit var checksumUrl: String
  var onProgress: Channel? = null
}

@TauriPlugin
class SelfUpdatePlugin(private val activity: Activity) : Plugin(activity) {
  private val worker = Executors.newSingleThreadExecutor()

  @Volatile
  private var busy = false

  private fun installsAllowed(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

  private fun resolveGranted(invoke: Invoke) {
    val result = JSObject()
    result.put("granted", installsAllowed())
    invoke.resolve(result)
  }

  @Command
  fun canInstall(invoke: Invoke) {
    resolveGranted(invoke)
  }

  @Command
  fun openInstallSettings(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      resolveGranted(invoke)
      return
    }
    val intent = Intent(
      Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
      Uri.parse("package:" + activity.packageName)
    )
    startActivityForResult(invoke, intent, "installSettingsResult")
  }

  @ActivityCallback
  private fun installSettingsResult(invoke: Invoke, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
    resolveGranted(invoke)
  }

  @Command
  fun install(invoke: Invoke) {
    val args = invoke.parseArgs(InstallArgs::class.java)
    if (busy) {
      invoke.reject("An update is already downloading.")
      return
    }
    busy = true
    worker.execute {
      try {
        val dir = File(activity.cacheDir, "updates")
        dir.deleteRecursively()
        if (!dir.mkdirs()) throw IllegalStateException("Could not create the download folder.")

        val expected = fetchChecksum(args.checksumUrl)
        val apk = File(dir, "ukacell-update.apk")
        val actual = download(args.url, apk, args.onProgress)
        if (!actual.equals(expected, ignoreCase = true)) {
          apk.delete()
          throw IllegalStateException("The download is damaged (checksum mismatch). Try again.")
        }
        checkPackage(apk)

        activity.runOnUiThread {
          try {
            openInstaller(apk)
            val result = JSObject()
            result.put("status", "installer-opened")
            invoke.resolve(result)
          } catch (error: Exception) {
            invoke.reject(error.message ?: "Could not open the Android installer.")
          } finally {
            busy = false
          }
        }
      } catch (error: Exception) {
        busy = false
        invoke.reject(error.message ?: error.toString())
      }
    }
  }

  private fun connect(url: String): HttpURLConnection {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout = 15_000
    connection.readTimeout = 30_000
    connection.instanceFollowRedirects = true
    connection.setRequestProperty("User-Agent", "Ukacell-Updater")
    val code = connection.responseCode
    if (code !in 200..299) {
      connection.disconnect()
      throw IllegalStateException("Download failed (HTTP $code).")
    }
    return connection
  }

  // `sha256sum` output: "<64 hex chars>  <file name>".
  private fun fetchChecksum(url: String): String {
    val connection = connect(url)
    val text = try {
      connection.inputStream.bufferedReader().use { it.readText() }
    } finally {
      connection.disconnect()
    }
    val hash = text.trim().split(Regex("\\s+")).firstOrNull().orEmpty()
    if (!Regex("^[0-9a-fA-F]{64}$").matches(hash)) {
      throw IllegalStateException("The release has no valid checksum file.")
    }
    return hash
  }

  // Streams `url` into `target` and returns its SHA-256 (lowercase hex).
  private fun download(url: String, target: File, progress: Channel?): String {
    val connection = connect(url)
    val total = connection.contentLengthLong
    val digest = MessageDigest.getInstance("SHA-256")
    var downloaded = 0L
    var lastReport = 0L
    try {
      connection.inputStream.use { input ->
        target.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            digest.update(buffer, 0, read)
            downloaded += read
            val now = System.currentTimeMillis()
            if (progress != null && now - lastReport >= 150) {
              lastReport = now
              report(progress, downloaded, total)
            }
          }
        }
      }
    } finally {
      connection.disconnect()
    }
    if (progress != null) report(progress, downloaded, total)
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun report(progress: Channel, downloaded: Long, total: Long) {
    val event = JSObject()
    event.put("downloaded", downloaded)
    event.put("total", total)
    progress.send(event)
  }

  @Suppress("DEPRECATION")
  private fun archiveInfo(apk: File): PackageInfo? {
    val manager = activity.packageManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      manager.getPackageArchiveInfo(apk.path, PackageManager.PackageInfoFlags.of(0))
    } else {
      manager.getPackageArchiveInfo(apk.path, 0)
    }
  }

  @Suppress("DEPRECATION")
  private fun installedInfo(): PackageInfo {
    val manager = activity.packageManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      manager.getPackageInfo(activity.packageName, PackageManager.PackageInfoFlags.of(0))
    } else {
      manager.getPackageInfo(activity.packageName, 0)
    }
  }

  @Suppress("DEPRECATION")
  private fun versionCodeOf(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

  private fun checkPackage(apk: File) {
    val archive = archiveInfo(apk)
    if (archive == null || archive.packageName != activity.packageName) {
      apk.delete()
      throw IllegalStateException("The download is not a Ukacell build.")
    }
    if (versionCodeOf(archive) <= versionCodeOf(installedInfo())) {
      apk.delete()
      throw IllegalStateException("This version is already installed.")
    }
  }

  private fun openInstaller(apk: File) {
    val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", apk)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    activity.startActivity(intent)
  }
}
