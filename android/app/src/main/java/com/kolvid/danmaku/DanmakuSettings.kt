package com.kolvid.danmaku

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

/**
 * 設定管理 — SharedPreferences 封裝
 * 球/彈幕/輸入欄的顏色、大小、透明度各自獨立
 */
object DanmakuSettings {

    private const val PREFS_NAME = "danmaku_overlay_prefs"

    // Keys
    private const val KEY_CURRENT_ROOM_CODE = "current_room_code"
    private const val KEY_DEFAULT_ROOM_CODE = "default_room_code"
    private const val KEY_JOINED_ROOM_CODES = "joined_room_codes"
    private const val KEY_CLIENT_ID = "installation_client_id"
    private const val KEY_NICKNAME = "nickname"
    private const val KEY_NICKNAME_CHANGE_DATE = "nickname_change_date"
    private const val KEY_BALL_COLOR = "ball_color"
    private const val KEY_BALL_SIZE = "ball_size"
    private const val KEY_BALL_OPACITY = "ball_opacity"
    private const val KEY_DM_COLOR = "dm_color"
    private const val KEY_DM_SIZE = "dm_size"
    private const val KEY_DM_OPACITY = "dm_opacity"
    private const val KEY_INPUT_COLOR = "input_color"
    private const val KEY_INPUT_SIZE = "input_size"
    private const val KEY_INPUT_OPACITY = "input_opacity"
    private const val KEY_BALL_X = "ball_x"
    private const val KEY_BALL_Y = "ball_y"
    private const val KEY_ONBOARDED = "onboarded"
    private const val KEY_DM_VISIBLE = "dm_visible"
    private const val KEY_PANEL_WIDTH = "panel_width"
    private const val KEY_PANEL_HEIGHT = "panel_height"

    // Defaults
    const val DEFAULT_BALL_COLOR = "#58A6FF"
    const val DEFAULT_BALL_SIZE = 56
    const val DEFAULT_BALL_OPACITY = 0.9f
    const val DEFAULT_DM_COLOR = "#E6EDF3"
    const val DEFAULT_DM_SIZE = 20f
    const val DEFAULT_DM_OPACITY = 0.9f
    const val DEFAULT_INPUT_COLOR = "#1A1A2E"
    const val DEFAULT_INPUT_SIZE = 16f
    const val DEFAULT_INPUT_OPACITY = 0.8f
    const val DEFAULT_DM_VISIBLE = true
    const val DEFAULT_PANEL_WIDTH = 320
    const val DEFAULT_PANEL_HEIGHT = 0  // 0 = wrap_content


    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // --- Room identity (server-issued roomCode only) ---
    fun getCurrentRoomCode(ctx: Context): String? =
        prefs(ctx).getString(KEY_CURRENT_ROOM_CODE, null)?.takeIf(RoomPolicy::isValidCode)

    fun setCurrentRoomCode(ctx: Context, roomCode: String) {
        require(RoomPolicy.isValidCode(roomCode))
        prefs(ctx).edit().putString(KEY_CURRENT_ROOM_CODE, roomCode).apply()
    }

    fun clearCurrentRoomCode(ctx: Context) {
        prefs(ctx).edit().remove(KEY_CURRENT_ROOM_CODE).apply()
    }

    fun getDefaultRoomCode(ctx: Context): String? =
        prefs(ctx).getString(KEY_DEFAULT_ROOM_CODE, null)?.takeIf(RoomPolicy::isValidCode)

    fun setDefaultRoomCode(ctx: Context, roomCode: String) {
        require(RoomPolicy.isValidCode(roomCode))
        prefs(ctx).edit().putString(KEY_DEFAULT_ROOM_CODE, roomCode).apply()
    }

    fun getJoinedRooms(ctx: Context): JoinedRoomList = JoinedRoomList(
        getDefaultRoomCode(ctx),
        prefs(ctx).getStringSet(KEY_JOINED_ROOM_CODES, emptySet()).orEmpty(),
    )

    fun addJoinedRoom(ctx: Context, roomCode: String) = saveJoinedRooms(ctx, getJoinedRooms(ctx).add(roomCode))
    fun removeJoinedRoom(ctx: Context, roomCode: String) = saveJoinedRooms(ctx, getJoinedRooms(ctx).remove(roomCode))
    private fun saveJoinedRooms(ctx: Context, rooms: JoinedRoomList) =
        prefs(ctx).edit().putStringSet(KEY_JOINED_ROOM_CODES, rooms.codes.filter { it != rooms.defaultRoomCode }.toSet()).apply()

    /** Stable installation UUID is intentionally non-secret and supplied in Socket.IO auth. */
    fun getOrCreateClientId(ctx: Context): String {
        val preferences = prefs(ctx)
        preferences.getString(KEY_CLIENT_ID, null)?.let { existing ->
            if (runCatching { UUID.fromString(existing) }.isSuccess) return existing
        }
        return UUID.randomUUID().toString().also { preferences.edit().putString(KEY_CLIENT_ID, it).commit() }
    }

    // --- Nickname identity ---
    fun getNickname(ctx: Context): String =
        NicknamePolicy.normalize(prefs(ctx).getString(KEY_NICKNAME, NicknamePolicy.DEFAULT_NICKNAME).orEmpty())

    fun getNicknameChangeDate(ctx: Context): String? =
        prefs(ctx).getString(KEY_NICKNAME_CHANGE_DATE, null)

    fun saveNicknameChange(ctx: Context, nickname: String, changeDate: String): Boolean {
        require(NicknamePolicy.isLocallyValid(nickname))
        require(changeDate.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$")))
        return prefs(ctx).edit()
            .putString(KEY_NICKNAME, NicknamePolicy.normalize(nickname))
            .putString(KEY_NICKNAME_CHANGE_DATE, changeDate)
            .commit()
    }

    // --- Ball ---
    fun getBallColor(ctx: Context): String = prefs(ctx).getString(KEY_BALL_COLOR, DEFAULT_BALL_COLOR)!!
    fun getBallSize(ctx: Context): Int = prefs(ctx).getInt(KEY_BALL_SIZE, DEFAULT_BALL_SIZE)
    fun getBallOpacity(ctx: Context): Float = prefs(ctx).getFloat(KEY_BALL_OPACITY, DEFAULT_BALL_OPACITY)
    fun setBallColor(ctx: Context, v: String) = prefs(ctx).edit().putString(KEY_BALL_COLOR, v).apply()
    fun setBallSize(ctx: Context, v: Int) = prefs(ctx).edit().putInt(KEY_BALL_SIZE, v).apply()
    fun setBallOpacity(ctx: Context, v: Float) = prefs(ctx).edit().putFloat(KEY_BALL_OPACITY, v).apply()

    // --- Danmaku ---
    fun getDmColor(ctx: Context): String = prefs(ctx).getString(KEY_DM_COLOR, DEFAULT_DM_COLOR)!!
    fun getDmSize(ctx: Context): Float = prefs(ctx).getFloat(KEY_DM_SIZE, DEFAULT_DM_SIZE)
    fun getDmOpacity(ctx: Context): Float = prefs(ctx).getFloat(KEY_DM_OPACITY, DEFAULT_DM_OPACITY)
    fun setDmColor(ctx: Context, v: String) = prefs(ctx).edit().putString(KEY_DM_COLOR, v).apply()
    fun setDmSize(ctx: Context, v: Float) = prefs(ctx).edit().putFloat(KEY_DM_SIZE, v).apply()
    fun setDmOpacity(ctx: Context, v: Float) = prefs(ctx).edit().putFloat(KEY_DM_OPACITY, v).apply()

    // --- Input ---
    fun getInputColor(ctx: Context): String = prefs(ctx).getString(KEY_INPUT_COLOR, DEFAULT_INPUT_COLOR)!!
    fun getInputSize(ctx: Context): Float = prefs(ctx).getFloat(KEY_INPUT_SIZE, DEFAULT_INPUT_SIZE)
    fun getInputOpacity(ctx: Context): Float = prefs(ctx).getFloat(KEY_INPUT_OPACITY, DEFAULT_INPUT_OPACITY)
    fun setInputColor(ctx: Context, v: String) = prefs(ctx).edit().putString(KEY_INPUT_COLOR, v).apply()
    fun setInputSize(ctx: Context, v: Float) = prefs(ctx).edit().putFloat(KEY_INPUT_SIZE, v).apply()
    fun setInputOpacity(ctx: Context, v: Float) = prefs(ctx).edit().putFloat(KEY_INPUT_OPACITY, v).apply()

    // --- Ball Position ---
    fun getBallX(ctx: Context): Int = prefs(ctx).getInt(KEY_BALL_X, -1)
    fun getBallY(ctx: Context): Int = prefs(ctx).getInt(KEY_BALL_Y, 100)
    fun setBallPos(ctx: Context, x: Int, y: Int) = prefs(ctx).edit().putInt(KEY_BALL_X, x).putInt(KEY_BALL_Y, y).apply()
    fun resetBallPosition(ctx: Context) = prefs(ctx).edit().putInt(KEY_BALL_X, -1).putInt(KEY_BALL_Y, 100).apply()

    // --- Onboarding ---
    fun getOnboarded(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_ONBOARDED, false)
    fun setOnboarded(ctx: Context, v: Boolean) = prefs(ctx).edit().putBoolean(KEY_ONBOARDED, v).apply()

    // --- Danmaku visibility ---
    fun getDmVisible(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_DM_VISIBLE, DEFAULT_DM_VISIBLE)
    fun setDmVisible(ctx: Context, v: Boolean) = prefs(ctx).edit().putBoolean(KEY_DM_VISIBLE, v).apply()

    // --- Panel size ---
    fun getPanelWidth(ctx: Context): Int = prefs(ctx).getInt(KEY_PANEL_WIDTH, DEFAULT_PANEL_WIDTH)
    fun getPanelHeight(ctx: Context): Int = prefs(ctx).getInt(KEY_PANEL_HEIGHT, DEFAULT_PANEL_HEIGHT)
    fun setPanelSize(ctx: Context, width: Int, height: Int) =
        prefs(ctx).edit().putInt(KEY_PANEL_WIDTH, width).putInt(KEY_PANEL_HEIGHT, height).apply()

    // --- Reset all ---
    fun resetAll(ctx: Context) {
        val onboarded = getOnboarded(ctx)
        val currentRoomCode = getCurrentRoomCode(ctx)
        val defaultRoomCode = getDefaultRoomCode(ctx)
        val joined = getJoinedRooms(ctx).codes.filter { it != defaultRoomCode }.toSet()
        val clientId = getOrCreateClientId(ctx)
        val nickname = getNickname(ctx)
        val nicknameChangeDate = getNicknameChangeDate(ctx)
        prefs(ctx).edit().clear()
            .putBoolean(KEY_ONBOARDED, onboarded)
            .putString(KEY_CURRENT_ROOM_CODE, currentRoomCode)
            .putString(KEY_DEFAULT_ROOM_CODE, defaultRoomCode)
            .putStringSet(KEY_JOINED_ROOM_CODES, joined)
            .putString(KEY_CLIENT_ID, clientId)
            .putString(KEY_NICKNAME, nickname)
            .putString(KEY_NICKNAME_CHANGE_DATE, nicknameChangeDate)
            .apply()
    }
}
