"""aims: long-range motivations, one solar system each

Revision ID: 3c1f2a9d7e10
Revises: b8897a1c6871
Create Date: 2026-10-10 20:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '3c1f2a9d7e10'
down_revision: Union[str, Sequence[str], None] = 'b8897a1c6871'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('aims',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('text_en', sa.Text(), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_aims_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_aims'))
    )
    op.create_index('ix_aims_user_position', 'aims', ['user_id', 'position'], unique=False)
    op.add_column('responsibilities', sa.Column('aim_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(op.f('fk_responsibilities_aim_id_aims'), 'responsibilities', 'aims', ['aim_id'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    op.drop_constraint(op.f('fk_responsibilities_aim_id_aims'), 'responsibilities', type_='foreignkey')
    op.drop_column('responsibilities', 'aim_id')
    op.drop_index('ix_aims_user_position', table_name='aims')
    op.drop_table('aims')
