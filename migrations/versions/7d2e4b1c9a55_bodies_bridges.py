"""bodies (databases, skills) and the bridges the user draws between bodies

Revision ID: 7d2e4b1c9a55
Revises: 3c1f2a9d7e10
Create Date: 2026-10-10 23:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '7d2e4b1c9a55'
down_revision: Union[str, Sequence[str], None] = '3c1f2a9d7e10'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('bodies',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('aim_id', sa.Uuid(), nullable=True),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('title', sa.Text(), nullable=False),
    sa.Column('title_en', sa.Text(), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('description_en', sa.Text(), nullable=False),
    sa.Column('private', sa.Boolean(), nullable=False),
    sa.Column('origin', sa.Enum('USER', 'AGENT', 'EXTERNAL', 'SYSTEM', name='origin', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['aim_id'], ['aims.id'], name=op.f('fk_bodies_aim_id_aims'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_bodies_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_bodies'))
    )
    op.create_index('ix_bodies_user_aim', 'bodies', ['user_id', 'aim_id'], unique=False)
    op.create_table('bridges',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('a_ref', sa.String(length=80), nullable=False),
    sa.Column('b_ref', sa.String(length=80), nullable=False),
    sa.Column('note', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_bridges_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_bridges')),
    sa.UniqueConstraint('user_id', 'a_ref', 'b_ref', name='uq_bridge_pair')
    )
    op.create_index('ix_bridges_user', 'bridges', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_bridges_user', table_name='bridges')
    op.drop_table('bridges')
    op.drop_index('ix_bodies_user_aim', table_name='bodies')
    op.drop_table('bodies')
