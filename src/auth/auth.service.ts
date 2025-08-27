import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
const scrypt = promisify(_scrypt);

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  /**
   * Validate a user by email & password.
   * Returns discriminated union so callers can switch on `reason`.
   */
  async validateUserByEmail(
    email: string,
    password: string,
  ): Promise<
    | {
        user: { id: string; email: string | null; username: string };
        reason: null;
      }
    | { user: null; reason: 'EMAIL_NOT_FOUND' | 'WRONG_PASSWORD' }
  > {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, username: true, passwordHash: true },
    });
    if (!user) return { user: null, reason: 'EMAIL_NOT_FOUND' };
    // passwordHash format: saltHex:derivedHex
    const [saltHex, storedHex] = user.passwordHash.split(':');
    if (!saltHex || !storedHex) {
      throw new InternalServerErrorException('Corrupt password record');
    }
    let derived: Buffer;
    try {
      derived = (await scrypt(password + saltHex, saltHex, 64)) as Buffer;
    } catch {
      throw new InternalServerErrorException('Password validation failed');
    }
    const stored = Buffer.from(storedHex, 'hex');
    if (stored.length !== derived.length || !timingSafeEqual(stored, derived)) {
      return { user: null, reason: 'WRONG_PASSWORD' };
    }
    const safe = {
      id: user.id,
      email: user.email ?? null,
      username: user.username,
    };
    return { user: safe, reason: null };
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
    // generate salt and hash
    const salt = randomBytes(16).toString('hex');
    let hash: Buffer;
    try {
      hash = (await scrypt(password + salt, salt, 64)) as Buffer;
    } catch {
      throw new InternalServerErrorException('Failed to hash password');
    }
    const passwordHash = `${salt}:${hash.toString('hex')}`;
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
