package com.sevencnup.codexremote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageChoicesTest {
    @Test fun readsTheObservedAsyncPromptOnOlderServers() {
        val prompt = "你说的“还是纯文本”，具体指哪一处？\n- AI 提问的选项，仍不能点选\n- 网页或文档预览，仍显示源文本"
        val groups = MessageChoices.parsePrompt(prompt)
        assertEquals(1, groups.size)
        assertEquals(listOf("AI 提问的选项，仍不能点选", "网页或文档预览，仍显示源文本"), groups[0].options)
    }

    @Test fun supportsPromptTitlesAndSpacedOptionsWithoutAQuestionMark() {
        val groups = MessageChoices.parsePrompt("选择处理方式\n\n- 先看效果\n\n- 继续修改\n\n接下来先处理哪个\n- 聊天\n- 文件")
        assertEquals(listOf("选择处理方式", "接下来先处理哪个"), groups.map { it.question })
        assertEquals(listOf("先看效果", "继续修改"), groups[0].options)
        assertEquals(listOf("聊天", "文件"), groups[1].options)
    }

    @Test fun supportsFreeTextQuestions() {
        assertEquals(listOf(MessageChoiceGroup("还需要调整哪里？", emptyList())), MessageChoices.parsePrompt("还需要调整哪里？"))
    }

    @Test fun formatsSelectedAndCustomAnswersTogether() {
        val groups = listOf(MessageChoiceGroup("主题", listOf("像素", "旧经典")), MessageChoiceGroup("补充说明？", emptyList()))
        assertEquals("1. 主题\n答：旧经典\n\n2. 补充说明？\n答：按钮缩小一点",
            MessageChoices.formatReply(groups, listOf(1, -2), listOf("", " 按钮缩小一点 ")))
    }

    @Test fun ordinaryProseAndCodeDoNotBecomeLegacyPromptCards() {
        assertTrue(MessageChoices.parsePrompt("已经处理完成。").isEmpty())
        assertTrue(MessageChoices.parsePrompt("```\n怎么选择？\n- 甲\n- 乙\n```").isEmpty())
        assertTrue(MessageChoices.parse("修改如下：\n- 修复布局\n- 调整颜色").isEmpty())
    }
}
