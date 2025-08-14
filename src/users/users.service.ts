import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Status } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  findByUsername(username: string) {
    return this.prisma.user.findUnique({ where: { username } });
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async create(username: string, email: string, passwordHash: string) {
    return this.prisma.user.create({
      data: { username, email, passwordHash, status: Status.OFFLINE },
    });
  }

  async setStatus(userId: string, status: Status) {
    return this.prisma.user.update({ where: { id: userId }, data: { status } });
  }
}
