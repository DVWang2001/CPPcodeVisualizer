#include<iostream>
#include<cstdlib>
using namespace std;
class Fraction{public:
   int x,y;
   Fraction(int a=0,int b=0):x(a),y(b){}
   Fraction operator-(Fraction b){return Fraction(abs(x*b.y-y*b.x),y*b.y);}
};
istream& operator>>(istream &is,Fraction &a){char c;return is>>a.x>>c>>a.y;}
ostream& operator<<(ostream &os,Fraction &a){return os<<a.x<<"/"<<a.y;}

int gcd(int a,int b){return b==0?a:gcd(b,a%b);}

class Section{public:
   Fraction a,b;
   Fraction len(){
      Fraction d=a-b;
      int g=gcd(d.x,d.y);
      return Fraction(d.x/g,d.y/g);
   }
};
istream& operator>>(istream &is,Section &a){
   return is>>a.a>>a.b;
}
ostream& operator<<(ostream &os,Section a){
   Fraction l=a.len();
   return os<<a.a<<" "<<a.b<<" "<<l;
}

int main(){
   int n;cin>>n;
   while(n--){
      Section sec;cin>>sec;
      cout<<sec<<endl;  //@ @guide uml:sec
   }
   return 0;
}
