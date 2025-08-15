import { Injectable, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async validateUserByEmail(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return null;
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return null;
    // strip sensitive
    const { passwordHash, ...safe } = user;
    return safe;
  }

  async login(user: { id: string; username: string; email: string }) {
    const payload = {
      sub: user.id,
      username: user.username,
      email: user.email,
    };
    const access_token = await this.jwt.signAsync(payload);
    return {
      access_token,
      user: { id: user.id, username: user.username, email: user.email },
    };
  }

  async register(username: string, email: string, password: string) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
    if (existing)
      throw new ConflictException('Username or email already taken');
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: { username, email, passwordHash },
    });
    const payload = {
      sub: user.id,
      username: user.username,
      email: user.email,
    };
    const access_token = await this.jwt.signAsync(payload);
    return {
      access_token,
      user: { id: user.id, username: user.username, email: user.email },
    };
  }
}
