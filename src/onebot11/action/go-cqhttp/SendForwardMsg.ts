import { unlink } from 'node:fs/promises'
import { OB11MessageNode } from '../../types'
import { ActionName } from '../types'
import { BaseAction, Schema } from '../BaseAction'
import { Peer } from '@/ntqqapi/types/msg'
import { ChatType, ElementType, RawMessage, SendMessageElement } from '@/ntqqapi/types'
import { MessageUnique } from '@/common/utils/messageUnique'
import { selfInfo } from '@/common/globalVars'
import { convertMessage2List, createSendElements, sendMsg, createPeer, CreatePeerMode } from '../../helper/createMessage'

interface Payload {
  user_id?: string | number
  group_id?: string | number
  messages: OB11MessageNode[]
  message_type?: 'group' | 'private'
}

interface Response {
  message_id: number
  forward_id?: string
}

export class SendForwardMsg extends BaseAction<Payload, Response> {
  actionName = ActionName.GoCQHTTP_SendForwardMsg
  payloadSchema = Schema.object({
    user_id: Schema.union([Number, String]),
    group_id: Schema.union([Number, String]),
    messages: Schema.array(Schema.any()).required(),
    message_type: Schema.union(['group', 'private'])
  })

  protected async _handle(payload: Payload) {
    let contextMode = CreatePeerMode.Normal
    if (payload.message_type === 'group') {
      contextMode = CreatePeerMode.Group
    } else if (payload.message_type === 'private') {
      contextMode = CreatePeerMode.Private
    }
    const peer = await createPeer(this.ctx, payload, contextMode)
    const returnMsg = await this.handleForwardNode(peer, payload.messages)
    return { message_id: returnMsg.msgShortId! }
  }

  private async cloneMsg(msg: RawMessage): Promise<RawMessage | undefined> {
    this.ctx.logger.info('克隆的目标消息', msg)
    const sendElements: SendMessageElement[] = []
    for (const ele of msg.elements) {
      sendElements.push(ele as SendMessageElement)
    }
    if (sendElements.length === 0) {
      this.ctx.logger.warn('需要clone的消息无法解析，将会忽略掉', msg)
    }
    this.ctx.logger.info('克隆消息', sendElements)
    try {
      const peer = {
        chatType: ChatType.friend,
        peerUid: selfInfo.uid
      }
      const nodeMsg = await this.ctx.ntMsgApi.sendMsg(peer, sendElements)
      await this.ctx.sleep(400)
      return nodeMsg
    } catch (e) {
      this.ctx.logger.warn(e, '克隆转发消息失败,将忽略本条消息', msg)
    }
  }

  // 返回一个合并转发的消息id
  private async handleForwardNode(destPeer: Peer, messageNodes: OB11MessageNode[]) {
    const selfPeer = {
      chatType: ChatType.friend,
      peerUid: selfInfo.uid,
    }
    let nodeMsgIds: string[] = []
    // 先判断一遍是不是id和自定义混用
    for (const messageNode of messageNodes) {
      // 一个node表示一个人的消息
      const nodeId = messageNode.data.id
      // 有nodeId表示一个子转发消息卡片
      if (nodeId) {
        const nodeMsg = await MessageUnique.getMsgIdAndPeerByShortId(+nodeId) || await MessageUnique.getPeerByMsgId(nodeId)
        if (!nodeMsg) {
          this.ctx.logger.warn('转发消息失败，未找到消息', nodeId)
          continue
        }
        nodeMsgIds.push(nodeMsg.MsgId)
      }
      else {
        // 自定义的消息
        // 提取消息段，发给自己生成消息id
        try {
          const { sendElements, deleteAfterSentFiles } = await createSendElements(
            this.ctx,
            convertMessage2List(messageNode.data.content),
            destPeer
          )
          this.ctx.logger.info('开始生成转发节点', sendElements)
          const sendElementsSplit: SendMessageElement[][] = []
          let splitIndex = 0
          for (const ele of sendElements) {
            if (!sendElementsSplit[splitIndex]) {
              sendElementsSplit[splitIndex] = []
            }

            if (ele.elementType === ElementType.FILE || ele.elementType === ElementType.VIDEO) {
              if (sendElementsSplit[splitIndex].length > 0) {
                splitIndex++
              }
              sendElementsSplit[splitIndex] = [ele]
              splitIndex++
            }
            else {
              sendElementsSplit[splitIndex].push(ele)
            }
            this.ctx.logger.info(sendElementsSplit)
          }
          // log("分割后的转发节点", sendElementsSplit)
          for (const eles of sendElementsSplit) {
            const nodeMsg = await sendMsg(this.ctx, selfPeer, eles, [])
            if (!nodeMsg) {
              this.ctx.logger.warn('转发节点生成失败', eles)
              continue
            }
            nodeMsgIds.push(nodeMsg.msgId)
            await this.ctx.sleep(400)
          }
          deleteAfterSentFiles.map(path => unlink(path))
        } catch (e) {
          this.ctx.logger.error('生成转发消息节点失败', e)
        }
      }
    }

    // 检查srcPeer是否一致，不一致则需要克隆成自己的消息, 让所有srcPeer都变成自己的，使其保持一致才能够转发
    const nodeMsgArray: RawMessage[] = []
    let srcPeer: Peer | null = null
    let needSendSelf = false
    for (const msgId of nodeMsgIds) {
      const nodeMsgPeer = await MessageUnique.getPeerByMsgId(msgId)
      if (nodeMsgPeer) {
        const nodeMsg = (await this.ctx.ntMsgApi.getMsgsByMsgId(nodeMsgPeer.Peer, [msgId])).msgList[0]
        srcPeer = srcPeer ?? { chatType: nodeMsg.chatType, peerUid: nodeMsg.peerUid }
        if (srcPeer.peerUid !== nodeMsg.peerUid) {
          needSendSelf = true
        }
        nodeMsgArray.push(nodeMsg)
      }
    }
    nodeMsgIds = nodeMsgArray.map((msg) => msg.msgId)
    if (needSendSelf) {
      for (const msg of nodeMsgArray) {
        if (msg.peerUid === selfPeer.peerUid) continue
        await this.cloneMsg(msg)
      }
    }
    if (nodeMsgIds.length === 0) {
      throw Error('转发消息失败，节点为空')
    }
    const returnMsg = await this.ctx.ntMsgApi.multiForwardMsg(srcPeer!, destPeer, nodeMsgIds)
    returnMsg.msgShortId = MessageUnique.createMsg(destPeer, returnMsg.msgId)
    return returnMsg
  }
}

export class SendPrivateForwardMsg extends SendForwardMsg {
  actionName = ActionName.GoCQHTTP_SendPrivateForwardMsg

  protected _handle(payload: Payload) {
    payload.message_type = 'private'
    return super._handle(payload)
  }
}

export class SendGroupForwardMsg extends SendForwardMsg {
  actionName = ActionName.GoCQHTTP_SendGroupForwardMsg

  protected _handle(payload: Payload) {
    payload.message_type = 'group'
    return super._handle(payload)
  }
}
