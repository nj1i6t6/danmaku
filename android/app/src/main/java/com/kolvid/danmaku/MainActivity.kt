package com.kolvid.danmaku

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var permissionStatus: TextView
    private lateinit var btnGrant: Button
    private lateinit var btnStart: Button
    private lateinit var btnResetPos: Button
    private lateinit var btnResetSettings: Button

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (DanmakuUiPolicy.canStartOverlay(Build.VERSION.SDK_INT, granted)) {
            startOverlayService()
        } else {
            showToast(getString(R.string.notification_permission_required))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        permissionStatus = findViewById(R.id.permission_status)
        btnGrant = findViewById(R.id.btn_grant_permission)
        btnStart = findViewById(R.id.btn_start_service)
        btnResetPos = findViewById(R.id.btn_reset_position)
        btnResetSettings = findViewById(R.id.btn_reset_settings)

        btnGrant.setOnClickListener {
            if (!Settings.canDrawOverlays(this)) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                )
                startActivity(intent)
            }
        }

        btnStart.setOnClickListener {
            requestNotificationPermissionAndStart()
        }

        btnResetPos.setOnClickListener {
            DanmakuSettings.resetBallPosition(this)
            sendBroadcast(
                Intent(DanmakuOverlayService.ACTION_RESET_POSITION).setPackage(packageName)
            )
            showToast(getString(R.string.ball_position_reset_done))
        }

        btnResetSettings.setOnClickListener {
            DanmakuSettings.resetAll(this)
            sendBroadcast(
                Intent(DanmakuOverlayService.ACTION_RESET_ALL).setPackage(packageName)
            )
            showToast(getString(R.string.settings_reset_done))
        }
    }

    override fun onResume() {
        super.onResume()
        updatePermissionStatus()
    }

    private fun updatePermissionStatus() {
        val hasPermission = Settings.canDrawOverlays(this)
        permissionStatus.text = getString(
            if (hasPermission) R.string.overlay_permission_granted else R.string.overlay_permission_required,
        )
        btnStart.isEnabled = hasPermission
        btnGrant.visibility = if (hasPermission) Button.GONE else Button.VISIBLE
    }

    private fun requestNotificationPermissionAndStart() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13+ — runtime POST_NOTIFICATIONS permission
            val granted = ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (granted) {
                startOverlayService()
            } else {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        } else {
            startOverlayService()
        }
    }

    private fun startOverlayService() {
        val intent = Intent(this, DanmakuOverlayService::class.java)
        startForegroundService(intent)
        finish()
    }

    private fun showToast(msg: String) {
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
    }
}
