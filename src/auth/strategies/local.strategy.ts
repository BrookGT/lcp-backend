import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from '../auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super({ usernameField: 'email', passwordField: 'password' });
  }

  async validate(email: string, password: string) {
    const result = await this.authService.validateUserByEmail(email, password);
    if (!result.user) {
      const msg =
        result.reason === 'EMAIL_NOT_FOUND'
          ? 'Email not found'
          : 'Incorrect password';
      throw new UnauthorizedException(msg);
    }
    // ensure req.user has the needed props for login payload
    const user = result.user;
    return { id: user.id, username: user.username, email: user.email } as any;
  }
}
