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

  handleConnection(client: Socket) {
    // no-op: connection acknowledged
  }

  handleDisconnect(client: Socket) {
    const room = this.lookup.get(client.id);
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
    socket.join(room);
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

    socket.leave(room);
  }
}
