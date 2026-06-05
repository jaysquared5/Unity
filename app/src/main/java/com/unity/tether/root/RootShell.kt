package com.unity.tether.root

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Minimal helper for running shell commands as root via the `su` binary.
 *
 * We deliberately keep this dependency-free (no libsu) so the project stays
 * easy to read and audit — every privileged action the app takes flows through
 * here, so this is the one place to look when reasoning about what we run as
 * root.
 */
object RootShell {

    data class Result(
        val exitCode: Int,
        val stdout: String,
        val stderr: String,
    ) {
        val isSuccess: Boolean get() = exitCode == 0
    }

    /** True if a `su` binary is present and grants us a root shell. */
    suspend fun isRootAvailable(): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val r = exec("id -u")
            r.isSuccess && r.stdout.trim() == "0"
        }.getOrDefault(false)
    }

    /**
     * Run one or more commands in a single root shell. Commands are joined with
     * newlines, so they share an environment and execute in order.
     */
    suspend fun exec(vararg commands: String): Result = withContext(Dispatchers.IO) {
        val process = ProcessBuilder("su")
            .redirectErrorStream(false)
            .start()

        process.outputStream.bufferedWriter().use { writer ->
            commands.forEach { cmd ->
                writer.write(cmd)
                writer.write("\n")
            }
            writer.write("exit\n")
            writer.flush()
        }

        val stdout = readFully(process.inputStream)
        val stderr = readFully(process.errorStream)
        val code = process.waitFor()
        Result(code, stdout.trim(), stderr.trim())
    }

    private fun readFully(stream: java.io.InputStream): String {
        val sb = StringBuilder()
        BufferedReader(InputStreamReader(stream)).use { reader ->
            var line = reader.readLine()
            while (line != null) {
                sb.append(line).append('\n')
                line = reader.readLine()
            }
        }
        return sb.toString()
    }
}
