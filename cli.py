import sys

def main(argv):
    if '--help' in argv:
        print('usage: cli.py add A B')
        return 0
    if len(argv) == 3 and argv[0] == 'add':
        print(int(argv[1]) + int(argv[2]))
        return 0
    print('usage: cli.py add A B', file=sys.stderr)
    return 2

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

