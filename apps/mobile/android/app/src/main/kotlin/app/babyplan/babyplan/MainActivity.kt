package app.babyplan.babyplan

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    companion object {
        private const val EXPORT_SAVE_REQUEST = 7301
        private const val NOTIFICATION_REQUEST = 7302
    }

    private data class PendingSave(
        val sourcePath: String,
        val result: MethodChannel.Result,
    )

    private var pendingSave: PendingSave? = null
    private var permissionResult: MethodChannel.Result? = null
    private var reminders: MethodChannel? = null

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == DailyReminderReceiver.OPEN_TODAY) reminders?.invokeMethod("openToday", null)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == NOTIFICATION_REQUEST) {
            permissionResult?.success(DailyReminderReceiver.allowed(this))
            permissionResult = null
        }
    }

    override fun onActivityResult(
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
    ) {
        if (requestCode != EXPORT_SAVE_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data)
            return
        }

        val pending = pendingSave ?: return
        pendingSave = null
        val source = File(pending.sourcePath)
        val uri: Uri? = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            pending.result.success(null)
            return
        }
        try {
            contentResolver.openOutputStream(uri)?.use { output ->
                source.inputStream().use { input -> input.copyTo(output) }
            } ?: error("无法打开目标文件")
            pending.result.success(uri.toString())
        } catch (error: Exception) {
            pending.result.error(
                "EXPORT_SAVE_FAILED",
                error.message ?: "没有完成文件保存",
                null,
            )
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        reminders = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "app.babyplan/reminders").also { channel ->
            channel.setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "permission" -> if (DailyReminderReceiver.allowed(this) || Build.VERSION.SDK_INT < 33) {
                            result.success(DailyReminderReceiver.allowed(this))
                        } else if (permissionResult != null) {
                            result.success(false)
                        } else {
                            permissionResult = result
                            try {
                                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST)
                            } catch (error: Exception) {
                                permissionResult = null
                                throw error
                            }
                        }
                        "schedule" -> {
                            DailyReminderReceiver.enable(this, requireNotNull(call.argument<String>("time")),
                                requireNotNull(call.argument<String>("zone")))
                            result.success(null)
                        }
                        "handled" -> { DailyReminderReceiver.updateHandled(this, call.argument<String>("date")); result.success(null) }
                        "cancel" -> { DailyReminderReceiver.disable(this); result.success(null) }
                        else -> result.notImplemented()
                    }
                } catch (_: Exception) {
                    result.error("REMINDER_FAILED", "本机无法安排提醒", null)
                }
            }
        }
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "app.babyplan/files",
        ).setMethodCallHandler { call, result ->
            if (call.method != "saveZip" && call.method != "saveFile") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            if (pendingSave != null) {
                result.error("SAVE_IN_PROGRESS", "已经有一个文件正在保存", null)
                return@setMethodCallHandler
            }
            val sourcePath = call.argument<String>("sourcePath")
            val fileName = call.argument<String>("fileName")
            val mimeType = call.argument<String>("mimeType")
                ?: if (call.method == "saveZip") "application/zip" else "application/json"
            if (sourcePath.isNullOrBlank() || fileName.isNullOrBlank()) {
                result.error("INVALID_ARGUMENT", "缺少文件路径或名称", null)
                return@setMethodCallHandler
            }
            val safeName = File(fileName).name.ifBlank { "babyplan-export.zip" }
            pendingSave = PendingSave(sourcePath, result)
            try {
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = mimeType
                    putExtra(Intent.EXTRA_TITLE, safeName)
                }
                startActivityForResult(intent, EXPORT_SAVE_REQUEST)
            } catch (error: Exception) {
                pendingSave = null
                result.error(
                    "EXPORT_PICKER_FAILED",
                    error.message ?: "无法打开保存位置",
                    null,
                )
            }
        }
    }
}
