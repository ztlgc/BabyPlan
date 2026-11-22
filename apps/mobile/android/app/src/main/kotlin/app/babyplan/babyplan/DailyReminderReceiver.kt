package app.babyplan.babyplan

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

class DailyReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ALARM -> deliver(context, intent.getLongExtra("due", 0L))
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED -> arm(context)
        }
    }

    companion object {
        private const val ALARM = "app.babyplan.DAILY_PLAY"
        const val OPEN_TODAY = "app.babyplan.OPEN_TODAY"
        private const val SETTINGS = "babyplan_daily_reminder"
        private const val CHANNEL = "babyplan_daily_play"
        private const val ID = 2301

        private fun settings(context: Context) = context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE)
        private fun alarms(context: Context) = context.getSystemService(AlarmManager::class.java)
        private fun notifications(context: Context) = context.getSystemService(NotificationManager::class.java)

        fun allowed(context: Context): Boolean = notifications(context).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

        private fun alarmIntent(context: Context) = Intent(context, DailyReminderReceiver::class.java).setAction(ALARM)

        fun enable(context: Context, time: String, zone: String) {
            val parsed = LocalTime.parse(time)
            require(parsed.isBefore(ReminderTiming.cutoff)) { "请选择 20:00 之前的提醒时段" }
            ZoneId.of(zone)
            val state = settings(context)
            if (state.getString("time", null) == time && state.getString("zone", null) == zone && state.getLong("due", 0L) != 0L) return
            state.edit().putString("time", time).putString("zone", zone).apply()
            arm(context)
        }

        fun updateHandled(context: Context, date: String?) {
            val state = settings(context)
            if (date == state.getString("handled", null)) return
            state.edit().putString("handled", date).apply()
            if (date != null) notifications(context).cancel(ID)
            arm(context)
        }

        fun disable(context: Context) {
            settings(context).edit().remove("time").remove("due").remove("handled").apply()
            PendingIntent.getBroadcast(context, ID, alarmIntent(context),
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)?.let { alarms(context).cancel(it) }
            notifications(context).cancel(ID)
        }

        private fun arm(context: Context) {
            val state = settings(context)
            val time = state.getString("time", null) ?: return
            val now = ZonedDateTime.now(ZoneId.of(state.getString("zone", "Asia/Shanghai")))
            val next = ReminderTiming.next(now, LocalTime.parse(time), state.getString("handled", null),
                state.getString("lastDelivered", null))
            val due = next.toInstant().toEpochMilli()
            val pending = PendingIntent.getBroadcast(context, ID, alarmIntent(context).putExtra("due", due),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            state.edit().putLong("due", due).apply()
            alarms(context).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, due, pending)
        }

        private fun deliver(context: Context, dueMillis: Long) {
            val state = settings(context)
            if (dueMillis <= 0 || state.getString("time", null) == null || state.getLong("due", 0L) != dueMillis) return
            val now = ZonedDateTime.now(ZoneId.of(state.getString("zone", "Asia/Shanghai")))
            val due = Instant.ofEpochMilli(dueMillis).atZone(now.zone)
            if (allowed(context) && ReminderTiming.canNotify(now, due, state.getString("handled", null),
                    state.getString("lastDelivered", null))) {
                val manager = notifications(context)
                if (Build.VERSION.SDK_INT >= 26) {
                    manager.createNotificationChannel(NotificationChannel(CHANNEL, "每天陪宝宝玩", NotificationManager.IMPORTANCE_DEFAULT))
                }
                val open = PendingIntent.getActivity(context, ID,
                    Intent(context, MainActivity::class.java).setAction(OPEN_TODAY).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                @Suppress("DEPRECATION")
                val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
                val notification = builder.setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle("今天，一起玩点什么？")
                    .setContentText("打开小芽看看今天的安排。时间不多，挑一个就好。")
                    .setCategory(Notification.CATEGORY_REMINDER).setOnlyAlertOnce(true)
                    .setAutoCancel(true).setContentIntent(open).build()
                if (state.edit().putString("lastDelivered", now.toLocalDate().toString()).commit()) {
                    try { manager.notify(ID, notification) } catch (_: SecurityException) { /* 权限可能刚被系统撤销。 */ }
                }
            }
            arm(context)
        }
    }
}
