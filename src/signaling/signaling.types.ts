import { Socket } from 'socket.io';

export interface PeerSocket {
  peer1?: Socket;
  peer2?: Socket;
}
