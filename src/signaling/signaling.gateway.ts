import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PeerSocket } from './signaling.types';
import { Status } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_ORIGIN?.split(',') ?? [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ],
    credentials: true,
  },
})
export class SignalingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  public server!: Server;

  private peerSockets: Map<string, PeerSocket> = new Map();
  private lookup: Map<string, string> = new Map();
  private userBySocket: Map<string, string> = new Map();
  private socketsByUser: Map<string, Set<string>> = new Map();
  private onlineCountByUser: Map<string, number> = new Map();
  private statusByUser: Map<string, Status> = new Map();
  // Track active call history records keyed by sorted user id pair
  private activeCallHistory: Map<string, string> = new Map();

  private callKey(a: string, b: string) {
    return [a, b].sort().join(':');
  }

  constructor(private prisma: PrismaService) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleConnection(client: Socket) {
    // no-op: connection acknowledged
  }

  handleDisconnect(client: Socket) {
    const room = this.lookup.get(client.id);
    const userId = this.userBySocket.get(client.id);
    if (userId) {
      const next = (this.onlineCountByUser.get(userId) ?? 1) - 1;
      if (next <= 0) {
        this.onlineCountByUser.delete(userId);
        this.statusByUser.set(userId, Status.OFFLINE);
        this.server.emit('presence', { userId, status: 'OFFLINE' });
        // persist
        this.prisma.user
          .update({ where: { id: userId }, data: { status: Status.OFFLINE } })
          .catch(() => void 0);
      } else {
        this.onlineCountByUser.set(userId, next);
      }
      this.userBySocket.delete(client.id);
      const set = this.socketsByUser.get(userId);
      if (set) {
        set.delete(client.id);
        if (set.size === 0) this.socketsByUser.delete(userId);
      }
    }
    if (!room) return;

    const currentPeers = this.peerSockets.get(room);
    if (!currentPeers) return;

    if (currentPeers.peer1?.id === client.id) {
      currentPeers.peer2?.emit('peerDisconnected', 'Peer1 has disconnected');
      this.peerSockets.delete(room);
      this.lookup.delete(client.id);
      if (currentPeers.peer2) this.lookup.delete(currentPeers.peer2.id);
      this.server.to(room).emit('roomClosed', room);
    } else if (currentPeers.peer2?.id === client.id) {
      currentPeers.peer2 = undefined;
      this.lookup.delete(client.id);
      currentPeers.peer1?.emit('peerDisconnected', 'Peer2 has disconnected');
    }
  }

  @SubscribeMessage('join')
  onJoin(@ConnectedSocket() socket: Socket, @MessageBody() room: string) {
    if (!room) return;
    if (!this.peerSockets.has(room)) {
      this.peerSockets.set(room, { peer1: socket });
      this.lookup.set(socket.id, room);
    } else {
      const currentPeers = this.peerSockets.get(room);
      if (currentPeers?.peer1 && !currentPeers?.peer2) {
        currentPeers.peer2 = socket;
        this.lookup.set(socket.id, room);
        currentPeers.peer1.emit('join', socket.id);
      } else {
        socket.emit('roomFull', room);
      }
    }
    void socket.join(room);
  }

  @SubscribeMessage('message')
  onMessage(@MessageBody() msg: string) {
    this.server.emit('message', msg);
  }

  @SubscribeMessage('offer')
  onOffer(@ConnectedSocket() socket: Socket, @MessageBody() offer: any) {
    const room = this.lookup.get(socket.id);
    if (!room) return;
    const currentPeers = this.peerSockets.get(room);
    if (!currentPeers) return;
    if (currentPeers.peer2?.id === socket.id) {
      currentPeers.peer1?.emit('offer', offer);
    } else if (currentPeers.peer1?.id === socket.id) {
      currentPeers.peer2?.emit('offer', offer);
    }
  }

  @SubscribeMessage('answer')
  onAnswer(@ConnectedSocket() socket: Socket, @MessageBody() answer: any) {
    const room = this.lookup.get(socket.id);
    if (!room) return;
    const currentPeers = this.peerSockets.get(room);
    if (!currentPeers) return;
    if (currentPeers.peer2?.id === socket.id) {
      currentPeers.peer1?.emit('answer', answer);
    } else if (currentPeers.peer1?.id === socket.id) {
      currentPeers.peer2?.emit('answer', answer);
    }
  }

  @SubscribeMessage('candidate')
  onCandidate(
    @ConnectedSocket() socket: Socket,
    @MessageBody() candidate: any,
  ) {
    const room = this.lookup.get(socket.id);
    if (!room) return;
    const currentPeers = this.peerSockets.get(room);
    if (!currentPeers) return;
    if (currentPeers.peer2?.id === socket.id) {
      currentPeers.peer1?.emit('candidate', candidate);
    } else if (currentPeers.peer1?.id === socket.id) {
      currentPeers.peer2?.emit('candidate', candidate);
    }
  }

  @SubscribeMessage('leave')
  onLeave(@ConnectedSocket() socket: Socket) {
    const room = this.lookup.get(socket.id);
    if (!room) return;
    const currentPeers = this.peerSockets.get(room);
    if (!currentPeers) {
      this.lookup.delete(socket.id);
      return;
    }

    // If peer1 (host) leaves, close room for everyone
    if (currentPeers.peer1?.id === socket.id) {
      if (currentPeers.peer2) {
        currentPeers.peer2.emit('peerDisconnected', 'Peer1 has left the call');
        this.lookup.delete(currentPeers.peer2.id);
      }
      this.peerSockets.delete(room);
      this.lookup.delete(socket.id);
      this.server.to(room).emit('roomClosed', room);
    }
    // If peer2 leaves, keep peer1 in the room
    else if (currentPeers.peer2?.id === socket.id) {
      currentPeers.peer2 = undefined;
      this.lookup.delete(socket.id);
      currentPeers.peer1?.emit('peerDisconnected', 'Peer2 has left the call');
    }

    void socket.leave(room);
  }

  // Presence updates from clients
  @SubscribeMessage('presence:update')
  onPresenceUpdate(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    payload: { userId: string; status: 'ONLINE' | 'BUSY' | 'OFFLINE' },
  ) {
    if (!payload?.userId || !payload?.status) return;
    this.userBySocket.set(socket.id, payload.userId);
    let set = this.socketsByUser.get(payload.userId);
    if (!set) {
      set = new Set();
      this.socketsByUser.set(payload.userId, set);
    }
    set.add(socket.id);
    if (payload.status === 'ONLINE') {
      const next = (this.onlineCountByUser.get(payload.userId) ?? 0) + 1;
      this.onlineCountByUser.set(payload.userId, next);
    } else if (payload.status === 'OFFLINE') {
      const next = (this.onlineCountByUser.get(payload.userId) ?? 1) - 1;
      if (next <= 0) this.onlineCountByUser.delete(payload.userId);
      else this.onlineCountByUser.set(payload.userId, next);
    }
    this.statusByUser.set(payload.userId, payload.status as Status);
    this.server.emit('presence', payload);
    // persist
    const newStatus =
      payload.status === 'BUSY'
        ? Status.BUSY
        : payload.status === 'ONLINE'
          ? Status.ONLINE
          : Status.OFFLINE;
    this.prisma.user
      .update({ where: { id: payload.userId }, data: { status: newStatus } })
      .catch(() => void 0);
  }

  // --- Call Invitation Flow ---

  /** Client emits 'call:invite' when initiating a call.
   *  payload: { fromUserId, fromName, toUserId, roomId }
   */
  @SubscribeMessage('call:invite')
  onCallInvite(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    payload: {
      fromUserId: string;
      fromName: string;
      toUserId: string;
      roomId: string;
    },
  ) {
    if (!payload?.fromUserId || !payload?.toUserId || !payload?.roomId) return;
    // Ensure we know mapping
    this.userBySocket.set(socket.id, payload.fromUserId);
    let set = this.socketsByUser.get(payload.fromUserId);
    if (!set) {
      set = new Set();
      this.socketsByUser.set(payload.fromUserId, set);
    }
    set.add(socket.id);

    const calleeStatus = this.statusByUser.get(payload.toUserId);
    if (calleeStatus === Status.BUSY) {
      socket.emit('call:unavailable', {
        toUserId: payload.toUserId,
        reason: 'User is busy',
      });
      return;
    }
    if (!this.socketsByUser.has(payload.toUserId)) {
      socket.emit('call:unavailable', {
        toUserId: payload.toUserId,
        reason: 'User offline',
      });
      return;
    }
    const targets = this.socketsByUser.get(payload.toUserId)!;
    targets.forEach((sid) => {
      this.server.to(sid).emit('call:incoming', {
        fromUserId: payload.fromUserId,
        fromName: payload.fromName,
        roomId: payload.roomId,
      });
    });
  }

  /** Callee accepts: payload { roomId, fromUserId, toUserId } */
  @SubscribeMessage('call:accept')
  onCallAccept(
    @MessageBody()
    payload: {
      roomId: string;
      fromUserId: string;
      toUserId: string;
    },
  ) {
    if (!payload?.roomId || !payload?.fromUserId || !payload?.toUserId) return;
    // Notify caller sockets
    const callerSockets = this.socketsByUser.get(payload.fromUserId);
    callerSockets?.forEach((sid) => {
      this.server.to(sid).emit('call:accepted', {
        roomId: payload.roomId,
        toUserId: payload.toUserId,
      });
    });
    // Mark both BUSY
    [payload.fromUserId, payload.toUserId].forEach((uid) => {
      this.statusByUser.set(uid, Status.BUSY);
      this.server.emit('presence', { userId: uid, status: 'BUSY' });
      this.prisma.user
        .update({ where: { id: uid }, data: { status: Status.BUSY } })
        .catch(() => void 0);
    });

    // Persist call history + update contact recency (fire and forget)
    const startedAt = new Date();
    void this.prisma.$transaction(async (tx) => {
      try {
        const call = await tx.callHistory.create({
          data: {
            callerId: payload.fromUserId,
            calleeId: payload.toUserId,
            startedAt,
          },
          select: { id: true },
        });
        // Upsert both directional contacts maintaining lastCallAt
        await Promise.all([
          tx.contact.upsert({
            where: {
              ownerId_contactId: {
                ownerId: payload.fromUserId,
                contactId: payload.toUserId,
              },
            },
            update: { lastCallAt: startedAt },
            create: {
              ownerId: payload.fromUserId,
              contactId: payload.toUserId,
              lastCallAt: startedAt,
            },
          }),
          tx.contact.upsert({
            where: {
              ownerId_contactId: {
                ownerId: payload.toUserId,
                contactId: payload.fromUserId,
              },
            },
            update: { lastCallAt: startedAt },
            create: {
              ownerId: payload.toUserId,
              contactId: payload.fromUserId,
              lastCallAt: startedAt,
            },
          }),
        ]);
        const key = this.callKey(payload.fromUserId, payload.toUserId);
        this.activeCallHistory.set(key, call.id);
      } catch {
        // swallow persistence errors so they don't break signaling
      }
    });
  }

  /** Callee rejects call: payload { fromUserId, toUserId } */
  @SubscribeMessage('call:reject')
  onCallReject(
    @MessageBody() payload: { fromUserId: string; toUserId: string },
  ) {
    if (!payload?.fromUserId || !payload?.toUserId) return;
    const callerSockets = this.socketsByUser.get(payload.fromUserId);
    callerSockets?.forEach((sid) => {
      this.server.to(sid).emit('call:rejected', {
        toUserId: payload.toUserId,
      });
    });
  }

  /** Caller cancels before accept: payload { fromUserId, toUserId } */
  @SubscribeMessage('call:cancel')
  onCallCancel(
    @MessageBody() payload: { fromUserId: string; toUserId: string },
  ) {
    if (!payload?.fromUserId || !payload?.toUserId) return;
    const calleeSockets = this.socketsByUser.get(payload.toUserId);
    calleeSockets?.forEach((sid) => {
      this.server.to(sid).emit('call:canceled', {
        fromUserId: payload.fromUserId,
      });
    });
  }

  // --- In-call chat ---
  /** Chat message within a joined room: payload { text, fromUserId?, fromName? } */
  @SubscribeMessage('chat:message')
  onChatMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    payload: { text: string; fromUserId?: string; fromName?: string },
  ) {
    if (!payload?.text) return;
    const room = this.lookup.get(socket.id);
    if (!room) return; // only allow chat for joined sockets
    const fromUserId = payload.fromUserId || this.userBySocket.get(socket.id);
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      roomId: room,
      text: payload.text.slice(0, 2000), // basic length guard
      fromUserId: fromUserId ?? 'anonymous',
      fromName: payload.fromName?.slice(0, 80) || 'User',
      ts: Date.now(),
    };
    // Emit to both peers in the room
    this.server.to(room).emit('chat:message', msg);
  }

  /** Either side notifies end of call to restore ONLINE if still connected. */
  @SubscribeMessage('call:end')
  onCallEnd(@MessageBody() payload: { userIds: string[] }) {
    if (!payload?.userIds) return;
    payload.userIds.forEach((uid) => {
      // Only downgrade BUSY -> ONLINE if they still have active connections
      const active = this.socketsByUser.get(uid)?.size ?? 0;
      const newStatus = active > 0 ? Status.ONLINE : Status.OFFLINE;
      this.statusByUser.set(uid, newStatus);
      this.server.emit('presence', {
        userId: uid,
        status: newStatus,
      });
      this.prisma.user
        .update({ where: { id: uid }, data: { status: newStatus } })
        .catch(() => void 0);
    });

    // If we have both user ids we can close the call history
    if (payload.userIds.length === 2) {
      const [a, b] = payload.userIds;
      const key = this.callKey(a, b);
      const callId = this.activeCallHistory.get(key);
      if (callId) {
        void this.prisma.callHistory
          .update({ where: { id: callId }, data: { endedAt: new Date() } })
          .catch(() => void 0);
        this.activeCallHistory.delete(key);
      }
      // Update lastCallAt timestamp for recency ordering
      const finishedAt = new Date();
      void this.prisma
        .$transaction(async (tx) => {
          await Promise.all([
            tx.contact.updateMany({
              where: { ownerId: a, contactId: b },
              data: { lastCallAt: finishedAt },
            }),
            tx.contact.updateMany({
              where: { ownerId: b, contactId: a },
              data: { lastCallAt: finishedAt },
            }),
          ]);
        })
        .catch(() => void 0);
    }
  }
}
